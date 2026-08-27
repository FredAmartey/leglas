import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { PassThrough } from "node:stream";

import { agentEnvironment, type AgentEffort } from "./agents.js";
import type { RunnerChild } from "./runner.js";

type ClaudeMessage = Record<string, unknown> & {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  is_error?: unknown;
};

export type ClaudeSdkOptions = {
  abortController: AbortController;
  cwd: string;
  env: NodeJS.ProcessEnv;
  permissionMode: "acceptEdits";
  settingSources: ["user", "project", "local"];
  persistSession: true;
  allowedTools?: string[];
};

export type ClaudeSdkQuery = AsyncIterable<ClaudeMessage> & {
  applyFlagSettings(settings: { effortLevel: AgentEffort | null }): Promise<void>;
  interrupt(): Promise<unknown>;
  close(): void;
};

export type ClaudeWarmQuery = {
  query(prompt: AsyncIterable<ClaudeMessage>): ClaudeSdkQuery;
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
  /** Spawn Claude Code and complete the SDK initialize handshake. */
  warm(): Promise<void>;
  run(input: ClaudeTurnInput, signal?: AbortSignal): Promise<RunnerChild>;
  close(): Promise<void>;
};

const INITIALIZE_TIMEOUT_MS = 30_000;
const IMAGE_MAX_BYTES = 5_000_000;

function imageMediaType(path: string): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return null;
}

/** Read only image shapes the Agent SDK accepts, bounded before loading bytes. */
async function claudeContent(prompt: string, images: readonly string[]): Promise<unknown> {
  if (images.length === 0) return prompt;
  const blocks: Record<string, unknown>[] = [{ type: "text", text: prompt }];
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
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const defaultStartup: ClaudeSdkStartup = async (params) => {
  // Type-only coupling is deliberate: if the optional SDK cannot load, warm()
  // rejects and the runner retains the installed `claude -p` fallback instead
  // of making the whole Leglas server fail at module import time.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.startup(params) as unknown as ClaudeWarmQuery;
};

class InputQueue implements AsyncIterable<ClaudeMessage> {
  private readonly queued: ClaudeMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<ClaudeMessage>) => void> = [];
  private ended = false;

  push(message: ClaudeMessage): void {
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

  [Symbol.asyncIterator](): AsyncIterator<ClaudeMessage> {
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
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): RunnerChild {
    if (event === "close" && this.terminal !== null) {
      const terminal = this.terminal;
      queueMicrotask(() => {
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
 * One long-lived Agent SDK streaming-input session.
 *
 * startup() pays the native CLI spawn and initialize handshake while Leglas is
 * idle. The first request consumes that warm handle; later requests enqueue a
 * user message into the same process. A result message ends only the synthetic
 * child for that turn, not Claude itself.
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
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly allowedCommands: readonly string[],
    private readonly startup: ClaudeSdkStartup,
  ) {}

  warm(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Claude Agent SDK is closed."));
    if (this.query !== null || this.warmQuery !== null) return Promise.resolve();
    if (this.warming !== null) return this.warming;

    const controller = new AbortController();
    this.processAbort = controller;
    const warming = this.startup({
      options: {
        abortController: controller,
        cwd: this.cwd,
        env: agentEnvironment(),
        permissionMode: "acceptEdits",
        settingSources: ["user", "project", "local"],
        persistSession: true,
        ...(this.allowedCommands.length === 0
          ? {}
          : { allowedTools: this.allowedCommands.map((command) => `Bash(${command} *)`) }),
      },
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
    })
      .then((warmQuery) => {
        if (
          this.closed ||
          controller.signal.aborted ||
          this.processAbort !== controller
        ) warmQuery.close();
        else this.warmQuery = warmQuery;
      })
      .catch((error: unknown) => {
        if (this.processAbort === controller) this.processAbort = null;
        throw error;
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
      // The runner deliberately starts fresh after its bounded session cap. A
      // null session id therefore rotates the process instead of quietly
      // carrying old context into what the caller believes is a clean turn.
      if (this.query !== null && input.sessionId === null) await this.resetQuery();
      if (signal?.aborted) throw new Error("cancelled");

      if (this.query === null) {
        // A saved session with no matching live SDK process is still supported
        // by the existing `claude --resume` path. Throw before consuming a fresh
        // warm handle so the runner can use that fallback without duplication.
        if (input.sessionId !== null) {
          throw new Error("Claude session is not loaded in the persistent process.");
        }
        await waitForAbort(this.startQuery(signal), signal);
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
      // Claude setting. No model is supplied, so their selected model remains
      // authoritative too.
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.resetQuery();
  }

  private async startQuery(signal?: AbortSignal): Promise<void> {
    await waitForAbort(this.warm(), signal);
    if (signal?.aborted) throw new Error("cancelled");
    const warmQuery = this.warmQuery;
    if (warmQuery === null) throw new Error("Claude Agent SDK did not warm.");

    const input = new InputQueue();
    const query = warmQuery.query(input);
    this.warmQuery = null;
    this.input = input;
    this.query = query;
    this.loadedSessionId = null;
    this.appliedEffort = null;
    this.pump = this.read(query);
  }

  private async read(query: ClaudeSdkQuery): Promise<void> {
    let endedNormally = false;
    try {
      for await (const message of query) {
        if (typeof message.session_id === "string" && message.session_id !== "") {
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

  private interrupt(
    query: ClaudeSdkQuery,
    child: ClaudeTurnChild,
    signal: NodeJS.Signals,
  ): void {
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
