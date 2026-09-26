import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { PassThrough } from "node:stream";

import { agentEnvironment, type AgentEffort } from "./agents.js";
import type { RunnerChild } from "./runner.js";

import { isString } from "../json.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type ClaudeMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
};

export type ClaudeSdkOptions = {
  abortController: AbortController;
  cwd: string;
  env: NodeJS.ProcessEnv;
  permissionMode: "acceptEdits";
  settingSources: ["user", "project", "local"];
  persistSession: true;
  allowedTools?: string[];
  /** A session to load into the process, so a released conversation continues. */
  resume?: string;
};

export type ClaudeSdkQuery = AsyncIterable<ClaudeMessage> & {
  applyFlagSettings(settings: { effortLevel: AgentEffort | null }): Promise<void>;
  /** Resolves when the SDK has sent the interrupt; the answer is not read. */
  interrupt(): Promise<object | undefined>;
  close(): void;
};

export type ClaudeWarmQuery = {
  query(prompt: AsyncIterable<SDKUserMessage>): ClaudeSdkQuery;
  close(): void;
};

export type ClaudeSdkStartup = (params: {
  options: ClaudeSdkOptions;
  initializeTimeoutMs: number;
}) => Promise<ClaudeWarmQuery>;

export type ClaudeTurnInput = {
  prompt: string;
  effort: AgentEffort | null;
  /** Null starts a fresh conversation; a value continues that session. */
  sessionId: string | null;
  images: readonly string[];
};

export type ClaudeTurnRunner = {
  /**
   * Spawns Claude Code and completes the SDK handshake. With a session id the
   * process loads that conversation, so one released while idle carries on
   * instead of taking the CLI path.
   */
  warm(sessionId?: string | null): Promise<void>;
  run(input: ClaudeTurnInput, signal?: AbortSignal): Promise<RunnerChild>;
  /** End the native process but keep the transport, so a later warm() works. */
  release(): Promise<void>;
  /** End the process and the transport for good. */
  close(): Promise<void>;
};

const INITIALIZE_TIMEOUT_MS = 30_000;

const IMAGE_MAX_BYTES = 5_000_000;

function imageMediaType(
  path: string,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const extension = extname(path).toLowerCase();

  if (extension === ".png") return "image/png";

  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";

  if (extension === ".webp") return "image/webp";

  if (extension === ".gif") return "image/gif";

  return null;
}

/** Read only image shapes the Agent SDK accepts, bounded before loading bytes. */
async function claudeContent(
  prompt: string,
  images: readonly string[],
): Promise<SDKUserMessage["message"]["content"]> {
  if (images.length === 0) return prompt;

  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = [
    { type: "text", text: prompt },
  ];

  for (const path of images) {
    const mediaType = imageMediaType(path);

    if (mediaType === null) continue;

    try {
      if ((await stat(path)).size > IMAGE_MAX_BYTES) continue;
      const data = await readFile(path);
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
      });
    } catch {
      // A missing capture is skipped; the prompt still names it for diagnosis.
    }
  }

  return blocks;
}

function waitForAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;

  if (signal.aborted) return Promise.reject(new Error("cancelled"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

const defaultStartup: ClaudeSdkStartup = async (params) => {
  // Type-only coupling on purpose: if the optional SDK can't load, warm()
  // rejects and the runner keeps the `claude -p` fallback instead of the server
  // failing at import.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  return sdk.startup(params);
};

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error("Claude input is closed.");
    const reader = this.readers.shift();

    if (reader === undefined) this.queued.push(message);
    else reader({ value: message, done: false });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;

    for (const reader of this.readers.splice(0)) {
      reader({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.queued.shift();

        if (message !== undefined) {
          return Promise.resolve({ value: message, done: false });
        }

        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

/** One SDK turn exposed through the child-process surface the queue runner uses. */
class ClaudeTurnChild implements RunnerChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly events = new EventEmitter();
  private ended = false;
  private terminal: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(private readonly interrupt: (signal: NodeJS.Signals) => void) {}

  once(event: "error", listener: (error: Error) => void): RunnerChild;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): RunnerChild;
  once(
    event: "error" | "close",
    listener:
      ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): RunnerChild {
    if (event === "close" && this.terminal !== null) {
      const terminal = this.terminal;
      queueMicrotask(() => {
        // SAFETY: The `close` overload pairs this callback with the stored terminal event.
        (listener as (code: number | null, signal: NodeJS.Signals | null) => void)(
          terminal.code,
          terminal.signal,
        );
      });

      return this;
    }

    this.events.once(event, listener);

    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.ended) return false;
    this.interrupt(signal);

    return true;
  }

  line(message: ClaudeMessage): void {
    if (!this.ended) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  finish(
    code: number | null,
    signal: NodeJS.Signals | null = null,
    error: string | null = null,
  ): void {
    if (this.ended) return;
    this.ended = true;
    this.terminal = { code, signal };

    if (error !== null) this.stderr.write(`${error}\n`);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.events.emit("close", code, signal));
  }
}

/**
 * One long-lived Agent SDK streaming session. startup() pays the spawn and
 * handshake while Leglas is idle; the first request takes the warm handle and
 * later ones enqueue into the same process. A result message ends only that
 * turn's synthetic child.
 */
class PersistentClaudeSession implements ClaudeTurnRunner {
  private warmQuery: ClaudeWarmQuery | null = null;
  private warming: Promise<void> | null = null;
  private processAbort: AbortController | null = null;
  private resetting: Promise<void> | null = null;
  private query: ClaudeSdkQuery | null = null;
  private input: InputQueue | null = null;
  private pump: Promise<void> | null = null;
  private active: ClaudeTurnChild | null = null;
  private loadedSessionId: string | null = null;
  private appliedEffort: AgentEffort | null = null;
  /** The session the warm handle was started to resume; null for a fresh one. */
  private warmedFor: string | null = null;
  private closed = false;
  /**
   * Counts every ask for a warm process. warm() and release() aren't awaited
   * and race both ways: a release must outlast a warm that started while it
   * settled, and stand down for a warm asked for after it began. The generation
   * it captured says which.
   */
  private generation = 0;

  constructor(
    private readonly cwd: string,
    private readonly allowedCommands: readonly string[],
    private readonly startup: ClaudeSdkStartup,
  ) {}

  warm(sessionId: string | null = null): Promise<void> {
    this.generation += 1;

    if (this.closed) return Promise.reject(new Error("Claude Agent SDK is closed."));

    if (this.query !== null) return Promise.resolve();

    if (this.warmQuery !== null || this.warming !== null) {
      if (this.warmedFor === sessionId) return this.warming ?? Promise.resolve();

      // A process can't change the session it loaded, so a handle warmed for
      // another conversation is replaced. One spawn, which the ask would have
      // cost anyway.
      return this.resetQuery().then(() => this.warm(sessionId));
    }

    this.warmedFor = sessionId;
    const controller = new AbortController();
    this.processAbort = controller;

    const options: ClaudeSdkOptions = {
      abortController: controller,
      cwd: this.cwd,
      env: agentEnvironment(),
      permissionMode: "acceptEdits",
      settingSources: ["user", "project", "local"],
      persistSession: true,
    };

    if (this.allowedCommands.length > 0) {
      options.allowedTools = this.allowedCommands.map((command) => `Bash(${command} *)`);
    }

    if (sessionId !== null) options.resume = sessionId;

    const warming = this.startup({ options, initializeTimeoutMs: INITIALIZE_TIMEOUT_MS })
      .then((warmQuery) => {
        if (this.closed || controller.signal.aborted || this.processAbort !== controller)
          warmQuery.close();
        else this.warmQuery = warmQuery;
      })
      .catch((cause: unknown) => {
        if (this.processAbort === controller) this.processAbort = null;
        throw cause;
      })
      .finally(() => {
        if (this.warming === warming) this.warming = null;
      });

    this.warming = warming;

    return warming;
  }

  async run(input: ClaudeTurnInput, signal?: AbortSignal): Promise<RunnerChild> {
    if (this.closed) throw new Error("Claude Agent SDK is closed.");

    if (this.active !== null) throw new Error("Claude already has an active turn.");

    if (signal?.aborted) throw new Error("cancelled");

    const onAbort = () => {
      void this.resetQuery();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    let child: ClaudeTurnChild | null = null;

    try {
      if (this.resetting !== null) await waitForAbort(this.resetting, signal);

      if (signal?.aborted) throw new Error("cancelled");

      // The runner starts fresh after its session cap, so a null session id
      // rotates the process rather than carrying old context into a clean turn.
      if (this.query !== null && input.sessionId === null) await this.resetQuery();

      if (signal?.aborted) throw new Error("cancelled");

      if (this.query === null) {
        // A saved session with no live process is loaded into a fresh one.
        // Otherwise the first request after an idle release, and every one
        // after it, fell to the `claude --resume` CLI.
        await waitForAbort(this.startQuery(signal, input.sessionId), signal);
      } else if (
        input.sessionId !== null &&
        this.loadedSessionId !== null &&
        input.sessionId !== this.loadedSessionId
      ) {
        throw new Error("A different Claude session is loaded in the persistent process.");
      }

      const query = this.query;
      const queue = this.input;

      if (query === null || queue === null) throw new Error("Claude Agent SDK did not start.");

      child = new ClaudeTurnChild((turnSignal) => {
        if (child !== null) this.interrupt(query, child, turnSignal);
      });
      this.active = child;

      // null clears only the SDK's flag layer and falls back to the user's own
      // setting. No model is passed, so theirs stands too.
      if (input.effort !== this.appliedEffort) {
        await waitForAbort(query.applyFlagSettings({ effortLevel: input.effort }), signal);
        this.appliedEffort = input.effort;
      }

      if (signal?.aborted) throw new Error("cancelled");
      queue.push({
        type: "user",
        message: { role: "user", content: await claudeContent(input.prompt, input.images) },
        parent_tool_use_id: null,
        origin: { kind: "human" },
      });

      return child;
    } catch (error) {
      if (child !== null && this.active === child) this.active = null;
      child?.finish(1, null, error instanceof Error ? error.message : String(error));
      await this.resetQuery();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Ends the native process but keeps the transport. A warm session is Claude
   * Code plus every MCP server the user configured, held for a request that may
   * not come. Called after an idle spell; the next warm() starts it again, and
   * a held session id goes through `claude --resume` meanwhile.
   */
  async release(): Promise<void> {
    // warm() doesn't wait for a reset in flight, so one started during an
    // earlier release lands a process after it. Reset until nothing is warm or
    // warming, unless a newer warm was asked for, which wins.
    const asOf = this.generation;

    do {
      await this.resetQuery();
    } while (
      this.generation === asOf &&
      (this.warming !== null || this.warmQuery !== null || this.query !== null)
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.resetQuery();
  }

  private async startQuery(signal?: AbortSignal, sessionId: string | null = null): Promise<void> {
    await waitForAbort(this.warm(sessionId), signal);

    if (signal?.aborted) throw new Error("cancelled");
    const warmQuery = this.warmQuery;

    if (warmQuery === null) throw new Error("Claude Agent SDK did not warm.");

    const input = new InputQueue();
    const query = warmQuery.query(input);
    this.warmQuery = null;
    this.input = input;
    this.query = query;
    // Optimistic for a resume; the process's own messages confirm or correct it.
    this.loadedSessionId = sessionId;
    this.appliedEffort = null;
    this.pump = this.read(query);
  }

  private async read(query: ClaudeSdkQuery): Promise<void> {
    let endedNormally = false;

    try {
      for await (const message of query) {
        if (isString(message.session_id) && message.session_id !== "") {
          this.loadedSessionId = message.session_id;
        }

        const child = this.active;

        if (child === null) continue;
        child.line(message);

        if (message.type === "result") {
          if (this.active === child) this.active = null;
          const success = message.subtype === "success" && message.is_error !== true;
          child.finish(success ? 0 : 1);
        }
      }

      endedNormally = true;
    } catch (error) {
      if (this.query === query) {
        const child = this.active;
        this.active = null;
        child?.finish(1, null, error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.query === query) {
        const child = this.active;
        this.active = null;

        if (child !== null) {
          child.finish(
            1,
            null,
            endedNormally ? "Claude Agent SDK ended before the turn completed." : null,
          );
        }

        this.query = null;
        this.input = null;
        this.pump = null;
        this.loadedSessionId = null;
        this.appliedEffort = null;
      }
    }
  }

  private interrupt(query: ClaudeSdkQuery, child: ClaudeTurnChild, signal: NodeJS.Signals): void {
    if (this.active !== child || this.query !== query) return;

    if (signal === "SIGKILL") {
      this.active = null;
      child.finish(null, signal);
      void this.resetQuery();

      return;
    }

    void query.interrupt().catch((error) => {
      if (this.active !== child) return;
      this.active = null;
      child.finish(1, null, error instanceof Error ? error.message : String(error));
      void this.resetQuery();
    });
  }

  private resetQuery(): Promise<void> {
    if (this.resetting !== null) return this.resetting;

    const resetting = this.performReset().finally(() => {
      if (this.resetting === resetting) this.resetting = null;
    });

    this.resetting = resetting;

    return resetting;
  }

  private async performReset(): Promise<void> {
    const warmQuery = this.warmQuery;
    const controller = this.processAbort;
    const query = this.query;
    const input = this.input;
    const pump = this.pump;
    this.warmQuery = null;
    this.warming = null;
    this.processAbort = null;
    this.query = null;
    this.input = null;
    this.pump = null;
    this.loadedSessionId = null;
    this.appliedEffort = null;
    this.warmedFor = null;
    warmQuery?.close();
    input?.close();
    query?.close();
    controller?.abort();

    if (pump !== null) {
      await Promise.race([
        pump.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }
}

export function createClaudeAgentSession(
  cwd: string,
  allowedCommands: readonly string[] = [],
  startup: ClaudeSdkStartup = defaultStartup,
): ClaudeTurnRunner {
  return new PersistentClaudeSession(cwd, allowedCommands, startup);
}
