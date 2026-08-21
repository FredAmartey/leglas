import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { agentEnvironment, type AgentEffort } from "./agents.js";
import type { RunnerChild } from "./runner.js";

type JsonRecord = Record<string, unknown>;

type AppServerProcess = {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): AppServerProcess;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): AppServerProcess;
  kill(signal: NodeJS.Signals): boolean;
};

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => AppServerProcess;

export type CodexTurnInput = {
  prompt: string;
  effort: AgentEffort | null;
  /** Null starts a fresh conversation; a value continues that thread. */
  sessionId: string | null;
};

export type CodexTurnRunner = {
  /** Complete the app-server handshake before a request reaches the queue. */
  warm(): Promise<void>;
  run(input: CodexTurnInput): Promise<RunnerChild>;
  close(): Promise<void>;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type ActiveTurn = {
  child: CodexTurnChild;
  threadId: string;
  turnId: string | null;
};

const REQUEST_TIMEOUT_MS = 30_000;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One turn presented through the same small child-process surface the existing
 * runner consumes. The real child is the long-lived app-server; this stream
 * ends when one turn does, while kill() maps to turn/interrupt.
 */
class CodexTurnChild implements RunnerChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly events = new EventEmitter();
  private ended = false;

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
    this.events.once(event, listener);
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.ended) return false;
    this.interrupt(signal);
    return true;
  }

  line(event: unknown): void {
    if (!this.ended) this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  finish(
    code: number | null,
    signal: NodeJS.Signals | null = null,
    error: string | null = null,
  ): void {
    if (this.ended) return;
    this.ended = true;
    if (error !== null) this.stderr.write(`${error}\n`);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.events.emit("close", code, signal));
  }
}

class PersistentCodexAppServer implements CodexTurnRunner {
  private process: AppServerProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private active: ActiveTurn | null = null;
  private loadedThreadId: string | null = null;
  private stderr: string[] = [];
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly spawn: CodexAppServerSpawn,
  ) {}

  warm(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed."));
    if (this.ready !== null) return this.ready;

    let process: AppServerProcess;
    try {
      process = this.spawn("codex", ["app-server", "--stdio"], {
        cwd: this.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.process = process;
    this.stderr = [];
    this.readLines(process.stdout, (line) => this.receive(process, line));
    this.readLines(process.stderr, (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 20) this.stderr.shift();
    });
    process.once("error", (error) => this.failProcess(process, error));
    process.once("close", (code, signal) => {
      const reason = signal === null ? `exit ${code ?? 0}` : `signal ${signal}`;
      this.failProcess(process, new Error(`Codex app-server ended with ${reason}.`));
    });

    this.ready = this.requestRaw("initialize", {
      clientInfo: { name: "leglas", title: "Leglas", version: "0.0.0" },
      capabilities: null,
    })
      .then(() => {
        this.notify("initialized", {});
      })
      .catch((error) => {
        if (this.process === process) {
          this.process = null;
          this.ready = null;
          process.kill("SIGTERM");
        }
        throw error;
      });
    return this.ready;
  }

  async run(input: CodexTurnInput): Promise<RunnerChild> {
    await this.warm();
    if (this.active !== null) throw new Error("Codex app-server already has an active turn.");

    const threadId = await this.thread(input.sessionId);
    const child = new CodexTurnChild((signal) => this.interrupt(signal));
    this.active = { child, threadId, turnId: null };
    child.line({ type: "thread.started", thread_id: threadId });

    try {
      const response = record(
        await this.requestRaw("turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: this.cwd,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [this.cwd],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          ...(input.effort === null ? {} : { effort: input.effort }),
        }),
      );
      const turn = record(response?.turn);
      const turnId = string(turn?.id);
      if (turnId === null) throw new Error("Codex app-server returned no turn id.");
      if (this.active?.child === child) this.active.turnId = turnId;
      return child;
    } catch (error) {
      if (this.active?.child === child) this.active = null;
      child.finish(1, null, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const process = this.process;
    if (process === null) return;

    process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => process.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (this.process === process) {
      process.kill("SIGKILL");
      this.process = null;
      this.ready = null;
    }
  }

  private async thread(sessionId: string | null): Promise<string> {
    if (sessionId !== null && this.loadedThreadId === sessionId) return sessionId;

    const method = sessionId === null ? "thread/start" : "thread/resume";
    const response = record(
      await this.requestRaw(
        method,
        sessionId === null
          ? {
              cwd: this.cwd,
              approvalPolicy: "never",
              sandbox: "workspace-write",
              serviceName: "leglas",
            }
          : {
              threadId: sessionId,
              cwd: this.cwd,
              approvalPolicy: "never",
              sandbox: "workspace-write",
            },
      ),
    );
    const thread = record(response?.thread);
    const threadId = string(thread?.id);
    if (threadId === null) throw new Error(`Codex app-server ${method} returned no thread id.`);
    this.loadedThreadId = threadId;
    return threadId;
  }

  private interrupt(signal: NodeJS.Signals): void {
    const active = this.active;
    if (active === null) return;
    if (signal === "SIGKILL") {
      active.child.finish(null, signal);
      this.active = null;
      this.loadedThreadId = null;
      this.process?.kill("SIGKILL");
      return;
    }
    if (active.turnId === null) return;
    void this.requestRaw("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    }).catch(() => {
      // The runner's existing grace timer escalates to SIGKILL if the turn
      // does not finish, so a failed polite interrupt needs no second path.
    });
  }

  private receive(process: AppServerProcess, line: string): void {
    if (this.process !== process) return;
    let message: JsonRecord | null;
    try {
      message = record(JSON.parse(line));
    } catch {
      message = null;
    }
    if (message === null) return;

    const id = typeof message.id === "number" ? message.id : null;
    const method = string(message.method);
    if (id !== null && method === null) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = record(message.error);
      if (error !== null) {
        pending.reject(new Error(string(error.message) ?? "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id !== null && method !== null) {
      this.answerServerRequest(id, method);
      return;
    }
    if (method !== null) this.notification(method, record(message.params));
  }

  private notification(method: string, params: JsonRecord | null): void {
    const active = this.active;
    if (active === null || params === null || params.threadId !== active.threadId) return;

    if (method === "item/started" || method === "item/completed") {
      const turnId = string(params.turnId);
      if (turnId !== null && active.turnId === null) active.turnId = turnId;
      if (active.turnId !== null && turnId !== active.turnId) return;
      const item = this.cliItem(record(params.item));
      if (item !== null) {
        active.child.line({
          type: method === "item/started" ? "item.started" : "item.completed",
          item,
        });
      }
      return;
    }

    if (method !== "turn/completed") return;
    const turn = record(params.turn);
    const turnId = string(turn?.id);
    if (active.turnId !== null && turnId !== active.turnId) return;
    const status = string(turn?.status);
    const error = record(turn?.error);
    const message = string(error?.message);
    active.child.line({ type: "turn.completed" });
    active.child.finish(status === "completed" ? 0 : 1, null, message);
    this.active = null;
  }

  private cliItem(item: JsonRecord | null): JsonRecord | null {
    if (item === null) return null;
    if (item.type === "commandExecution") {
      return { type: "command_execution", command: item.command };
    }
    if (item.type === "fileChange") {
      return { type: "file_change", changes: item.changes };
    }
    if (item.type === "agentMessage") {
      return { type: "agent_message", text: item.text };
    }
    if (item.type === "reasoning") return { type: "reasoning" };
    return { type: typeof item.type === "string" ? item.type : "unknown" };
  }

  private answerServerRequest(id: number, method: string): void {
    if (method === "item/commandExecution/requestApproval") {
      this.respond(id, { decision: "decline" });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      this.respond(id, { decision: "decline" });
      return;
    }
    this.respondError(id, -32601, `Leglas does not handle ${method}.`);
  }

  private requestRaw(method: string, params: JsonRecord): Promise<unknown> {
    const process = this.process;
    if (process === null) return Promise.reject(new Error("Codex app-server is unavailable."));
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonRecord): void {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: number, result: JsonRecord): void {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number, code: number, message: string): void {
    this.process?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  private failProcess(process: AppServerProcess, error: Error): void {
    if (this.process !== process) return;
    this.process = null;
    this.ready = null;
    this.loadedThreadId = null;
    const detail = this.stderr.length === 0 ? error.message : `${error.message} ${this.stderr.at(-1)}`;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.pending.clear();
    if (this.active !== null) {
      this.active.child.finish(1, null, detail);
      this.active = null;
    }
  }

  private readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    let buffered = "";
    stream.on("data", (chunk: string | Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const cleaned = line.replace(/\r$/, "");
        if (cleaned !== "") onLine(cleaned);
      }
    });
    stream.on("end", () => {
      if (buffered !== "") onLine(buffered.replace(/\r$/, ""));
    });
  }
}

const defaultSpawn: CodexAppServerSpawn = (command, args, options) =>
  nodeSpawn(command, args, {
    ...options,
    env: agentEnvironment(),
  }) as unknown as AppServerProcess;

export function createCodexAppServer(
  cwd: string,
  spawn: CodexAppServerSpawn = defaultSpawn,
): CodexTurnRunner {
  return new PersistentCodexAppServer(cwd, spawn);
}
