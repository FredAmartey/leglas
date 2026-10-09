import { required } from "../test-helpers.js";
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
import type { AgentEffort } from "./agents.js";
import type { RunnerChild } from "./runner.js";

/** How long a wait may take before it is a hang rather than a slow machine. */
const EVENTUALLY_MS = 15_000;

type Message = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;

/** What the SDK streams back, as far as the session reads it. */
type SdkEvent = {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  message?: unknown;
};

class FakeQuery implements ClaudeSdkQuery {
  readonly applied: Array<{ effortLevel: AgentEffort | null }> = [];
  readonly interrupt = vi.fn(async () => ({}));
  readonly close = vi.fn(() => {
    if (this.closeDelayMs === 0) this.end();
    else setTimeout(() => this.end(), this.closeDelayMs);
  });
  private readonly queued: SdkEvent[] = [];
  private readonly readers: Array<(result: IteratorResult<SdkEvent>) => void> = [];
  private ended = false;

  constructor(private readonly closeDelayMs = 0) {}

  async applyFlagSettings(settings: { effortLevel: AgentEffort | null }): Promise<void> {
    this.applied.push(settings);
  }

  emit(message: SdkEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<SdkEvent> {
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
  const deadline = Date.now() + EVENTUALLY_MS;

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

/** Ends the turn `child` runs with a result naming `sessionId`, and resolves to its exit code. */
function ended(
  query: FakeQuery,
  child: RunnerChild,
  sessionId: string,
  subtype = "success",
): Promise<number | null> {
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );

  query.emit({ type: "result", subtype, is_error: subtype !== "success", session_id: sessionId });

  return closed;
}

/** The abort controller an SDK warmup was started with. */
type Warmup = { controller: AbortController | null };

describe("Claude Agent SDK transport", () => {
  test("a release outlasts a warm started while an earlier release was settling", async () => {
    // warm() doesn't wait for a reset in flight, so one started between two
    // releases could land a process after the second returned. The last call
    // wins.
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
    await until(() => required(sdk.warms[1]).close.mock.calls.length === 1);

    // Released, not closed: a later ask still brings it up.
    await session.warm();
    expect(sdk.calls).toHaveLength(3);
    expect(required(sdk.warms[2]).close).not.toHaveBeenCalled();
    await session.close();
  });

  test("a warm asked for after a release began survives it", async () => {
    // The reverse race: the idle clock fires as the composer takes focus. The
    // release started first, but the warm is newer and its process serves the
    // coming request.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();

    const release = session.release();
    const warming = session.warm();
    await release;
    await warming;

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.abortController.signal.aborted).toBe(false);
    expect(required(sdk.warms[1]).close).not.toHaveBeenCalled();
    // Still warm: another ask starts nothing new.
    await session.warm();
    expect(sdk.calls).toHaveLength(2);
    await session.close();
  });

  test("a released conversation is loaded into the next warm process", async () => {
    // Without this, the first request after an idle release fell to the `claude
    // --resume` CLI, and so did every one after it.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();
    const first = await session.run({ prompt: "first", effort: null, sessionId: null, images: [] });
    const warm = required(sdk.warms[0]);
    await nextInput(warm);
    warm.output.emit({ type: "system", subtype: "init", session_id: "claude_1" });
    expect(await ended(warm.output, first, "claude_1")).toBe(0);

    await session.release();

    // Warmed on intent with the conversation to continue, before the request.
    await session.warm("claude_1");
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.resume).toBe("claude_1");

    const second = await session.run({
      prompt: "second",
      effort: null,
      sessionId: "claude_1",
      images: [],
    });

    expect(sdk.calls).toHaveLength(2);
    const resumed = required(sdk.warms[1]);
    await expect(nextInput(resumed)).resolves.toMatchObject({
      message: { role: "user", content: "second" },
    });
    expect(await ended(resumed.output, second, "claude_1")).toBe(0);
    await session.close();
  });

  test("a handle warmed for another conversation is replaced, whichever way the request goes", async () => {
    // Warmed fresh, and the request continues a session.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();

    await session.run({ prompt: "continue", effort: null, sessionId: "claude_3", images: [] });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[0]?.options).not.toHaveProperty("resume");
    expect(required(sdk.warms[0]).close).toHaveBeenCalledOnce();
    expect(sdk.calls[1]?.options.resume).toBe("claude_3");
    await session.close();

    // Warmed for a session, and the request starts fresh: the runner starts
    // cold after its turn cap or a failure, and a process that loaded the old
    // conversation would carry it into that turn.
    const again = harness();
    const fresh = createClaudeAgentSession("/project", [], again.startup);
    await fresh.warm("claude_3");

    await fresh.run({ prompt: "fresh", effort: null, sessionId: null, images: [] });
    expect(again.calls).toHaveLength(2);
    expect(required(again.warms[0]).close).toHaveBeenCalledOnce();
    expect(again.calls[1]?.options).not.toHaveProperty("resume");
    await fresh.close();
  });

  test("a fresh turn after a resumed conversation rotates the process", async () => {
    // After the turn cap or a failure, a live process that resumed the old
    // conversation must not get the fresh turn.
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);

    const resumed = await session.run({
      prompt: "more",
      effort: "high",
      sessionId: "claude_5",
      images: [],
    });

    // Nothing was warmed for it, and the run still loads the session it names.
    expect(sdk.calls[0]?.options.resume).toBe("claude_5");
    const warm = required(sdk.warms[0]);
    await nextInput(warm);
    await ended(warm.output, resumed, "claude_5");

    await session.run({ prompt: "clean slate", effort: "high", sessionId: null, images: [] });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options).not.toHaveProperty("resume");
    expect(warm.output.close).toHaveBeenCalledOnce();
    // A new process starts at the person's own settings, so the effort is set on it again.
    expect(sdk.warms[1]?.output.applied).toEqual([{ effortLevel: "high" }]);
    await expect(nextInput(required(sdk.warms[1]))).resolves.toMatchObject({
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

    const warm = required(sdk.warms[0]);

    const first = await session.run({
      prompt: "first prompt",
      effort: "high",
      sessionId: null,
      images: [],
    });

    expect(warm.output.applied).toEqual([{ effortLevel: "high" }]);
    await expect(nextInput(warm)).resolves.toMatchObject({
      type: "user",
      message: { role: "user", content: "first prompt" },
      origin: { kind: "human" },
    });

    const lines: string[] = [];
    first.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

    warm.output.emit({ type: "system", subtype: "init", session_id: "claude_1" });
    warm.output.emit({
      type: "assistant",
      session_id: "claude_1",
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/project/src.ts" } }],
      },
    });
    expect(await ended(warm.output, first, "claude_1")).toBe(0);
    expect(lines.join("")).toContain('"type":"assistant"');

    const second = await session.run({
      prompt: "second prompt",
      effort: null,
      sessionId: "claude_1",
      images: [],
    });

    expect(warm.query).toHaveBeenCalledTimes(1);
    expect(warm.output.applied).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
    await expect(nextInput(warm)).resolves.toMatchObject({
      message: { content: "second prompt" },
    });
    expect(await ended(warm.output, second, "claude_1")).toBe(0);
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

    const warm = required(sdk.warms[0]);
    const input = await nextInput(warm);
    const message = input.message;

    if (!Array.isArray(message.content)) throw new Error("Expected image content blocks.");
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
    await ended(warm.output, child, "claude_images");
    await session.close();
  });

  test("maps a polite stop to the SDK interrupt without killing the session", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);

    const child = await session.run({
      prompt: "keep going",
      effort: null,
      sessionId: null,
      images: [],
    });

    const warm = required(sdk.warms[0]);
    expect(child.kill("SIGTERM")).toBe(true);
    expect(warm.output.interrupt).toHaveBeenCalledOnce();

    await ended(warm.output, child, "claude_cancel");
    expect(warm.output.close).not.toHaveBeenCalled();
    await session.close();
  });

  test("reports SDK error results as failed turns", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);

    const child = await session.run({
      prompt: "fail",
      effort: "high",
      sessionId: null,
      images: [],
    });

    const warm = required(sdk.warms[0]);
    expect(await ended(warm.output, child, "claude_fail", "error_during_execution")).toBe(1);
    await session.close();
  });

  test("replays a result that arrives before the close listener is attached", async () => {
    const sdk = harness();
    const session = createClaudeAgentSession("/project", [], sdk.startup);
    await session.warm();
    const running = session.run({ prompt: "quick", effort: null, sessionId: null, images: [] });
    const warm = required(sdk.warms[0]);
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

    // Let the turn end completely, close included, before anyone listens, as
    // when the runner is slower than the SDK.
    child.stdout.resume();
    await new Promise((resolve) => child.stdout.once("end", resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const closed = await Promise.race([
      new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code))),
      new Promise<"never">((resolve) => setTimeout(() => resolve("never"), 1000)),
    ]);

    expect(closed).toBe(0);
    await session.close();
  });

  test("aborts an in-flight SDK warmup during shutdown", async () => {
    const got: Warmup = { controller: null };

    const startup: ClaudeSdkStartup = ({ options }) =>
      new Promise((_resolve, reject) => {
        got.controller = options.abortController;
        options.abortController.signal.addEventListener(
          "abort",
          () => reject(new Error("warmup aborted")),
          { once: true },
        );
      });

    const session = createClaudeAgentSession("/project", [], startup);
    const warming = session.warm();
    await until(() => got.controller !== null);

    await expect(session.close()).resolves.toBeUndefined();
    expect(got.controller?.signal.aborted).toBe(true);
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
    await ended(required(queries[0]), first, "claude_old");

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
    await ended(required(queries[1]), next, "claude_new");
    await session.close();
  });
});
