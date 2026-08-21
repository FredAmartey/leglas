import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  createCodexAppServer,
  type CodexAppServerSpawn,
} from "./codex-app-server.js";

type Message = Record<string, unknown>;

class FakeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Message[] = [];
  readonly signals: NodeJS.Signals[] = [];
  private readonly events = new EventEmitter();
  private buffered = "";
  private ended = false;

  constructor(private readonly closeOnSigterm = true) {
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffered += chunk.toString();
      const lines = this.buffered.split("\n");
      this.buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line !== "") this.messages.push(JSON.parse(line) as Message);
      }
    });
  }

  once(event: "error" | "close", listener: (...args: unknown[]) => void): FakeProcess {
    this.events.once(event, listener);
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.ended) return false;
    if (signal === "SIGTERM" && !this.closeOnSigterm) return true;
    this.ended = true;
    queueMicrotask(() => this.events.emit("close", null, signal));
    return true;
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function harness(closeOnSigterm = true) {
  const processes: FakeProcess[] = [];
  const spawn: CodexAppServerSpawn = (_command, _args, _options) => {
    const process = new FakeProcess(closeOnSigterm);
    processes.push(process);
    return process;
  };
  return { processes, spawn };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}

function byMethod(process: FakeProcess, method: string): Message[] {
  return process.messages.filter((message) => message.method === method);
}

async function initialize(requestTimeoutMs = 30_000, closeOnSigterm = true) {
  const spawned = harness(closeOnSigterm);
  const server = createCodexAppServer("/project", spawned.spawn, requestTimeoutMs);
  const warming = server.warm();
  await until(() => spawned.processes.length === 1);
  const process = spawned.processes[0] as FakeProcess;
  await until(() => byMethod(process, "initialize").length === 1);
  const request = byMethod(process, "initialize")[0] as Message;
  process.send({ id: request.id, result: { userAgent: "codex-test" } });
  await warming;
  await until(() => byMethod(process, "initialized").length === 1);
  return { process, server, spawned };
}

describe("Codex app-server transport", () => {
  test("warms once, streams a turn and reuses its loaded thread", async () => {
    const { process, server, spawned } = await initialize();
    await expect(server.warm()).resolves.toBeUndefined();
    expect(spawned.processes).toHaveLength(1);

    const firstRun = server.run({ prompt: "first prompt", effort: "high", sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);
    const threadStart = byMethod(process, "thread/start")[0] as Message;
    expect(threadStart.params).toMatchObject({
      cwd: "/project",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(threadStart.params).not.toHaveProperty("model");
    process.send({ id: threadStart.id, result: { thread: { id: "th_1" } } });

    await until(() => byMethod(process, "turn/start").length === 1);
    const firstTurn = byMethod(process, "turn/start")[0] as Message;
    expect(firstTurn.params).toMatchObject({
      threadId: "th_1",
      input: [{ type: "text", text: "first prompt" }],
      effort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
    });
    process.send({ id: firstTurn.id, result: { turn: { id: "turn_1" } } });
    const firstChild = await firstRun;
    const firstLines: string[] = [];
    firstChild.stdout.on("data", (chunk: Buffer) => firstLines.push(chunk.toString()));
    const firstClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        firstChild.once("close", (code, signal) => resolve({ code, signal })),
    );

    process.send({
      method: "item/started",
      params: {
        threadId: "th_1",
        turnId: "turn_1",
        item: { type: "commandExecution", command: "pnpm test" },
      },
    });
    process.send({
      method: "item/completed",
      params: {
        threadId: "th_1",
        turnId: "turn_1",
        item: {
          type: "fileChange",
          changes: [{ path: "/project/src.ts", kind: "update", diff: "" }],
        },
      },
    });
    process.send({
      method: "turn/completed",
      params: { threadId: "th_1", turn: { id: "turn_1", status: "completed", error: null } },
    });
    await expect(firstClosed).resolves.toEqual({ code: 0, signal: null });
    expect(firstLines.join("")).toContain('"type":"thread.started"');
    expect(firstLines.join("")).toContain('"type":"command_execution"');
    expect(firstLines.join("")).toContain('"type":"file_change"');

    const secondRun = server.run({ prompt: "second prompt", effort: null, sessionId: "th_1" });
    await until(() => byMethod(process, "turn/start").length === 2);
    expect(byMethod(process, "thread/start")).toHaveLength(1);
    expect(byMethod(process, "thread/resume")).toHaveLength(0);
    const secondTurn = byMethod(process, "turn/start")[1] as Message;
    expect(secondTurn.params).not.toHaveProperty("effort");
    process.send({ id: secondTurn.id, result: { turn: { id: "turn_2" } } });
    const secondChild = await secondRun;
    const secondClosed = new Promise<void>((resolve) =>
      secondChild.once("close", () => resolve()),
    );
    process.send({
      method: "turn/completed",
      params: { threadId: "th_1", turn: { id: "turn_2", status: "completed", error: null } },
    });
    await secondClosed;
    await server.close();
    expect(process.signals).toContain("SIGTERM");
  });

  test("resumes a stored thread after a new app-server process", async () => {
    const { process, server } = await initialize();
    const running = server.run({ prompt: "continue", effort: "max", sessionId: "stored_1" });
    await until(() => byMethod(process, "thread/resume").length === 1);
    const resume = byMethod(process, "thread/resume")[0] as Message;
    process.send({ id: resume.id, result: { thread: { id: "stored_1" } } });
    await until(() => byMethod(process, "turn/start").length === 1);
    const turn = byMethod(process, "turn/start")[0] as Message;
    process.send({ id: turn.id, result: { turn: { id: "turn_1" } } });
    const child = await running;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    process.send({
      method: "turn/completed",
      params: {
        threadId: "stored_1",
        turn: { id: "turn_1", status: "completed", error: null },
      },
    });
    await closed;
    expect(turn.params).toMatchObject({ effort: "max" });
    await server.close();
  });

  test("maps cancellation to turn/interrupt", async () => {
    const { process, server } = await initialize();
    const running = server.run({ prompt: "keep going", effort: null, sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);
    const thread = byMethod(process, "thread/start")[0] as Message;
    process.send({ id: thread.id, result: { thread: { id: "th_cancel" } } });
    await until(() => byMethod(process, "turn/start").length === 1);
    const turn = byMethod(process, "turn/start")[0] as Message;
    process.send({ id: turn.id, result: { turn: { id: "turn_cancel" } } });
    const child = await running;
    expect(child.kill("SIGTERM")).toBe(true);
    await until(() => byMethod(process, "turn/interrupt").length === 1);
    expect(byMethod(process, "turn/interrupt")[0]?.params).toEqual({
      threadId: "th_cancel",
      turnId: "turn_cancel",
    });
    const interrupt = byMethod(process, "turn/interrupt")[0] as Message;
    process.send({ id: interrupt.id, result: {} });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    process.send({
      method: "turn/completed",
      params: {
        threadId: "th_cancel",
        turn: { id: "turn_cancel", status: "interrupted", error: null },
      },
    });
    await closed;
    await server.close();
  });

  test("replays an immediate completion to a late close listener", async () => {
    const { process, server } = await initialize();
    const running = server.run({ prompt: "quick", effort: null, sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);
    const thread = byMethod(process, "thread/start")[0] as Message;
    process.send({ id: thread.id, result: { thread: { id: "th_quick" } } });
    await until(() => byMethod(process, "turn/start").length === 1);
    const turn = byMethod(process, "turn/start")[0] as Message;

    // Both lines arrive in one stdout batch. The completion is handled before
    // run() resolves and before the queue can attach its close listener.
    process.stdout.write(
      `${JSON.stringify({ id: turn.id, result: { turn: { id: "turn_quick" } } })}\n` +
        `${JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "th_quick",
            turn: { id: "turn_quick", status: "completed", error: null },
          },
        })}\n`,
    );
    const child = await running;
    const closed = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    await expect(closed).resolves.toBe(0);
    await server.close();
  });

  test("fails pending requests instead of crashing on an asynchronous stdin error", async () => {
    const { process, server } = await initialize();
    const running = server.run({ prompt: "pipe", effort: null, sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);

    process.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    await expect(running).rejects.toThrow("EPIPE");
    expect(process.signals).toContain("SIGTERM");
    await server.close();
  });

  test("terminates an ambiguously accepted turn before reporting its timeout", async () => {
    const { process, server } = await initialize(10);
    const running = server.run({ prompt: "timeout", effort: null, sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);
    const thread = byMethod(process, "thread/start")[0] as Message;
    process.send({ id: thread.id, result: { thread: { id: "th_timeout" } } });
    await until(() => byMethod(process, "turn/start").length === 1);

    await expect(running).rejects.toThrow("turn/start timed out");
    expect(process.signals).toContain("SIGTERM");
    await server.close();
  });

  test("waits for an in-progress reset to escalate before shutdown completes", async () => {
    const { process, server } = await initialize(30_000, false);
    const running = server.run({ prompt: "stubborn", effort: null, sessionId: null });
    await until(() => byMethod(process, "thread/start").length === 1);
    process.stdin.emit("error", new Error("write EPIPE"));
    await expect(running).rejects.toThrow("EPIPE");

    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    await closing;
    expect(process.signals).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
  });
});
