import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  createClaudeAgentSession,
  type ClaudeSdkOptions,
  type ClaudeSdkQuery,
  type ClaudeSdkStartup,
  type ClaudeWarmQuery,
} from "./claude-agent-session.js";

type Message = Record<string, unknown>;

class FakeQuery implements ClaudeSdkQuery {
  readonly applied: Array<{ effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null }> = [];
  readonly interrupt = vi.fn(async () => ({}));
  readonly close = vi.fn(() => {
    if (this.closeDelayMs === 0) this.end();
    else setTimeout(() => this.end(), this.closeDelayMs);
  });
  private readonly queued: Message[] = [];
  private readonly readers: Array<(result: IteratorResult<Message>) => void> = [];
  private ended = false;

  constructor(private readonly closeDelayMs = 0) {}

  async applyFlagSettings(settings: {
    effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }): Promise<void> {
    this.applied.push(settings);
  }

  emit(message: Message): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.queued.push(message);
    else reader({ value: message, done: false });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) {
      reader({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message !== undefined) return Promise.resolve({ value: message, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

class FakeWarmQuery implements ClaudeWarmQuery {
  readonly query = vi.fn((prompt: AsyncIterable<Message>) => {
    this.input = prompt;
    return this.output;
  });
  readonly close = vi.fn();
  input: AsyncIterable<Message> | null = null;

  constructor(readonly output = new FakeQuery()) {}
}

function harness() {
  const calls: Array<{ options: ClaudeSdkOptions; initializeTimeoutMs: number }> = [];
  const warms: FakeWarmQuery[] = [];
  const startup: ClaudeSdkStartup = async (params) => {
    calls.push(params);
    const warm = new FakeWarmQuery();
    warms.push(warm);
    return warm;
  };
  return { calls, warms, startup };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function nextInput(warm: FakeWarmQuery): Promise<Message> {
  const input = warm.input;
  if (input === null) throw new Error("query input was not attached");
  const next = await input[Symbol.asyncIterator]().next();
  if (next.done) throw new Error("query input ended");
  return next.value;
}

describe("Claude Agent SDK transport", () => {
  test("a release outlasts a warm started while an earlier release was settling", async () => {
    // warm() does not wait for a reset in flight, so one begun between two
    // releases used to land a new process after the second release returned.
    // The last call wins: nothing is warm once release() settles.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();
    expect(sdk.calls).toHaveLength(1);

    const first = session.release();
    const warming = session.warm();
    const second = session.release();
    await first;
    await second;
    await warming;

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.abortController.signal.aborted).toBe(true);
    await until(() => (sdk.warms[1] as FakeWarmQuery).close.mock.calls.length === 1);

    // Released, not closed: a later ask still brings it up.
    await session.warm();
    expect(sdk.calls).toHaveLength(3);
    expect((sdk.warms[2] as FakeWarmQuery).close).not.toHaveBeenCalled();
    await session.close();
  });

  test("a warm asked for after a release began survives it", async () => {
    // The other direction of the same race: the idle clock fires as the
    // composer takes focus. The release started first, but the warm is the
    // newer intent and its process is the one the coming request will use.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();

    const release = session.release();
    const warming = session.warm();
    await release;
    await warming;

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.abortController.signal.aborted).toBe(false);
    expect((sdk.warms[1] as FakeWarmQuery).close).not.toHaveBeenCalled();
    // Still warm: another ask starts nothing new.
    await session.warm();
    expect(sdk.calls).toHaveLength(2);
    await session.close();
  });

  test("a released conversation is loaded into the next warm process", async () => {
    // Without this, the first request after an idle release fell to the
    // `claude --resume` CLI path, and every request after it did too, because
    // the persistent process never had the session the runner kept naming.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();
    const first = await session.run({ prompt: "first", effort: null, sessionId: null, images: [] });
    const warm = sdk.warms[0] as FakeWarmQuery;
    await nextInput(warm);
    const firstClosed = new Promise<number | null>((resolve) =>
      first.once("close", (code) => resolve(code)),
    );
    warm.output.emit({ type: "system", subtype: "init", session_id: "claude_1" });
    warm.output.emit({ type: "result", subtype: "success", session_id: "claude_1" });
    expect(await firstClosed).toBe(0);

    await session.release();

    // Warmed on intent with the conversation to continue, before the request.
    await session.warm("claude_1");
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.resume).toBe("claude_1");

    const second = await session.run({ prompt: "second", effort: null, sessionId: "claude_1", images: [] });
    expect(sdk.calls).toHaveLength(2);
    const resumed = sdk.warms[1] as FakeWarmQuery;
    await expect(nextInput(resumed)).resolves.toMatchObject({
      message: { role: "user", content: "second" },
    });
    const secondClosed = new Promise<number | null>((resolve) =>
      second.once("close", (code) => resolve(code)),
    );
    resumed.output.emit({ type: "result", subtype: "success", session_id: "claude_1" });
    expect(await secondClosed).toBe(0);
    await session.close();
  });

  test("a run naming a session loads it even when nothing was warmed for it", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);

    await session.run({ prompt: "again", effort: null, sessionId: "claude_7", images: [] });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.options.resume).toBe("claude_7");
    await session.close();
  });

  test("a handle warmed fresh is replaced when the request continues a session", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();

    await session.run({ prompt: "continue", effort: null, sessionId: "claude_3", images: [] });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[0]?.options).not.toHaveProperty("resume");
    expect((sdk.warms[0] as FakeWarmQuery).close).toHaveBeenCalledOnce();
    expect(sdk.calls[1]?.options.resume).toBe("claude_3");
    await session.close();
  });

  test("a handle warmed for a session is replaced when the request starts fresh", async () => {
    // The runner starts cold after its turn cap or a failure; a process that
    // already loaded the old conversation would carry it into what the
    // runner believes is a clean turn.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm("claude_3");

    await session.run({ prompt: "fresh", effort: null, sessionId: null, images: [] });
    expect(sdk.calls).toHaveLength(2);
    expect((sdk.warms[0] as FakeWarmQuery).close).toHaveBeenCalledOnce();
    expect(sdk.calls[1]?.options).not.toHaveProperty("resume");
    await session.close();
  });

  test("a fresh turn after a resumed conversation rotates the process", async () => {
    // The runner starts fresh after its turn cap or a failure. A live process
    // that resumed the old conversation must not receive that turn.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    const resumed = await session.run({ prompt: "more", effort: null, sessionId: "claude_5", images: [] });
    const warm = sdk.warms[0] as FakeWarmQuery;
    await nextInput(warm);
    const resumedClosed = new Promise<void>((resolve) => resumed.once("close", () => resolve()));
    warm.output.emit({ type: "result", subtype: "success", session_id: "claude_5" });
    await resumedClosed;

    await session.run({ prompt: "clean slate", effort: null, sessionId: null, images: [] });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options).not.toHaveProperty("resume");
    expect(warm.output.close).toHaveBeenCalled();
    await expect(nextInput(sdk.warms[1] as FakeWarmQuery)).resolves.toMatchObject({
      message: { role: "user", content: "clean slate" },
    });
    await session.close();
  });

  test("warms once and keeps multiple turns in one SDK process", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", ["npx leglas register"], sdk.startup);
    await session.warm();
    await session.warm();
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]).toMatchObject({
      options: {
        cwd: "/project",
        permissionMode: "acceptEdits",
        settingSources: ["user", "project", "local"],
        persistSession: true,
        allowedTools: ["Bash(npx leglas register *)"],
      },
      initializeTimeoutMs: 30_000,
    });
    expect(sdk.calls[0]?.options).not.toHaveProperty("model");
    expect(sdk.calls[0]?.options).not.toHaveProperty("effort");
    expect(sdk.calls[0]?.options.abortController).toBeInstanceOf(AbortController);

    const warm = sdk.warms[0] as FakeWarmQuery;
    const first = await session.run({ prompt: "first prompt", effort: "high", sessionId: null, images: [] });
    expect(warm.output.applied).toEqual([{ effortLevel: "high" }]);
    await expect(nextInput(warm)).resolves.toMatchObject({
      type: "user",
      message: { role: "user", content: "first prompt" },
      origin: { kind: "human" },
    });

    const lines: string[] = [];
    first.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    const firstClosed = new Promise<number | null>((resolve) =>
      first.once("close", (code) => resolve(code)),
    );
    warm.output.emit({ type: "system", subtype: "init", session_id: "claude_1" });
    warm.output.emit({
      type: "assistant",
      session_id: "claude_1",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/project/src.ts" } },
        ],
      },
    });
    warm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_1",
    });
    await expect(firstClosed).resolves.toBe(0);
    expect(lines.join("")).toContain('"type":"assistant"');

    const second = await session.run({
      prompt: "second prompt",
      effort: null,
      sessionId: "claude_1",
      images: [],
    });
    expect(warm.query).toHaveBeenCalledTimes(1);
    expect(warm.output.applied).toEqual([
      { effortLevel: "high" },
      { effortLevel: null },
    ]);
    await expect(nextInput(warm)).resolves.toMatchObject({
      message: { content: "second prompt" },
    });
    const secondClosed = new Promise<number | null>((resolve) =>
      second.once("close", (code) => resolve(code)),
    );
    warm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_1",
    });
    await expect(secondClosed).resolves.toBe(0);
    await session.close();
    expect(warm.output.close).toHaveBeenCalledOnce();
  });

  test("hands readable bounded images to Claude as base64 content blocks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-claude-images-"));
    const image = join(cwd, "frame.png");
    const tooLarge = join(cwd, "large.jpg");
    writeFileSync(image, Buffer.from("image bytes"));
    writeFileSync(tooLarge, Buffer.alloc(5_000_001));
    const sdk = harness();
    const session = createClaudeAgentSession(cwd, [], sdk.startup);
    const child = await session.run({
      prompt: "look at these",
      effort: null,
      sessionId: null,
      images: [image, tooLarge, join(cwd, "missing.webp"), join(cwd, "not-an-image.txt")],
    });
    const warm = sdk.warms[0] as FakeWarmQuery;
    const input = await nextInput(warm);
    const message = input.message as { content: Record<string, any>[] };
    expect(message.content).toEqual([
      { type: "text", text: "look at these" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("image bytes").toString("base64"),
        },
      },
    ]);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    warm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_images",
    });
    await closed;
    await session.close();
  });

  test("rotates to a fresh process when the caller starts a fresh session", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    const first = await session.run({ prompt: "first", effort: "max", sessionId: null, images: [] });
    const firstWarm = sdk.warms[0] as FakeWarmQuery;
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    firstWarm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_old",
    });
    await firstClosed;

    const second = await session.run({ prompt: "fresh", effort: "xhigh", sessionId: null, images: [] });
    expect(firstWarm.output.close).toHaveBeenCalledOnce();
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.warms[1]?.output.applied).toEqual([{ effortLevel: "xhigh" }]);
    const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
    sdk.warms[1]?.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_new",
    });
    await secondClosed;
    await session.close();
  });

  test("maps a polite stop to the SDK interrupt without killing the session", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    const child = await session.run({ prompt: "keep going", effort: null, sessionId: null, images: [] });
    const warm = sdk.warms[0] as FakeWarmQuery;
    expect(child.kill("SIGTERM")).toBe(true);
    expect(warm.output.interrupt).toHaveBeenCalledOnce();

    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    warm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_cancel",
    });
    await closed;
    expect(warm.output.close).not.toHaveBeenCalled();
    await session.close();
  });

  test("reports SDK error results as failed turns", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    const child = await session.run({ prompt: "fail", effort: "high", sessionId: null, images: [] });
    const closed = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    sdk.warms[0]?.output.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["overloaded"],
      session_id: "claude_fail",
    });
    await expect(closed).resolves.toBe(1);
    await session.close();
  });

  test("replays a result that arrives before the close listener is attached", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();
    const running = session.run({ prompt: "quick", effort: null, sessionId: null, images: [] });
    const warm = sdk.warms[0] as FakeWarmQuery;
    await until(() => warm.input !== null);
    await expect(nextInput(warm)).resolves.toMatchObject({
      message: { content: "quick" },
    });
    warm.output.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_quick",
    });

    const child = await running;
    const closed = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    await expect(closed).resolves.toBe(0);
    await session.close();
  });

  test("aborts an in-flight SDK warmup during shutdown", async () => {
    let controller: AbortController | null = null;
    const startup: ClaudeSdkStartup = ({ options }) =>
      new Promise((_resolve, reject) => {
        controller = options.abortController;
        options.abortController.signal.addEventListener(
          "abort",
          () => reject(new Error("warmup aborted")),
          { once: true },
        );
      });
    const session = createClaudeAgentSession("/project", [], startup);
    const warming = session.warm();
    await until(() => controller !== null);

    await expect(session.close()).resolves.toBeUndefined();
    expect(controller?.signal.aborted).toBe(true);
    await expect(warming).rejects.toThrow("warmup aborted");
  });

  test("finishes cancelled rotation cleanup before starting the next query", async () => {
    const queries: FakeQuery[] = [];
    const startup: ClaudeSdkStartup = async () => {
      const query = new FakeQuery(queries.length === 0 ? 40 : 0);
      queries.push(query);
      return new FakeWarmQuery(query);
    };
    const session = createClaudeAgentSession("/project", [], startup);
    const first = await session.run({ prompt: "first", effort: null, sessionId: null, images: [] });
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    queries[0]?.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_old",
    });
    await firstClosed;

    const controller = new AbortController();
    const rotating = session.run(
      { prompt: "cancel", effort: null, sessionId: null, images: [] },
      controller.signal,
    );
    await until(() => (queries[0]?.close.mock.calls.length ?? 0) === 1);
    controller.abort();
    const nextRun = session.run({ prompt: "next", effort: null, sessionId: null, images: [] });

    await expect(rotating).rejects.toThrow("cancelled");
    const next = await nextRun;
    expect(queries).toHaveLength(2);
    expect(queries[1]?.close).not.toHaveBeenCalled();
    const nextClosed = new Promise<void>((resolve) => next.once("close", () => resolve()));
    queries[1]?.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude_new",
    });
    await nextClosed;
    await session.close();
  });
});
