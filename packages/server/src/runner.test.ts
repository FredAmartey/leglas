import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveAgentChoice } from "./agents.js";
import type { ClaudeTurnInput, ClaudeTurnRunner } from "./claude-agent-session.js";
import type { CodexTurnRunner } from "./codex-app-server.js";
import { LOCAL_PREVIEWS_PATH } from "./local-previews.js";
import { appendRequest, readRequests } from "./requests.js";
import { startRunner, type RunnerChild, type RunnerSpawn } from "./runner.js";

const input = (title: string) => ({
  title,
  url: "/",
  intent: `change ${title}`,
  target: null,
  prompt: `prompt for ${title}`,
});

function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & RunnerChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = vi.fn(() => {
    emitter.stdout.emit("end");
    emitter.stderr.emit("end");
    queueMicrotask(() => emitter.emit("close", null, "SIGTERM"));
    return true;
  });
  const close = (code: number) => {
    emitter.stdout.emit("end");
    emitter.stderr.emit("end");
    emitter.emit("close", code, null);
  };
  return { child: emitter, close };
}

function spawner() {
  const calls: Parameters<RunnerSpawn>[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn: RunnerSpawn = (...args) => {
    calls.push(args);
    const child = fakeChild();
    children.push(child);
    return child.child;
  };
  return { spawn, calls, children };
}

function manualClock() {
  let callback: (() => void) | null = null;
  const clearInterval = vi.fn();
  return {
    setInterval: (next: () => void, milliseconds: number): unknown => {
      expect(milliseconds).toBe(2000);
      callback = next;
      return "timer";
    },
    clearInterval,
    tick: () => callback?.(),
  };
}

const until = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * Beat the manual clock until something happens.
 *
 * One `tick()` is not enough on its own: the runner refuses to overlap a tick
 * that is still in flight, and the tail of a run does real asynchronous work
 * (writing the verdict, or dropping the finished request) after the thing a
 * test waits on is already observable. In the server that costs nothing,
 * because the real interval fires again two seconds later. With a clock the
 * test drives, a swallowed tick is the end of the story, so the test keeps
 * beating.
 */
const tickUntil = async (
  clock: { tick(): void },
  condition: () => Promise<boolean> | boolean,
): Promise<void> =>
  until(async () => {
    clock.tick();
    return await condition();
  });

afterEach(() => vi.restoreAllMocks());

describe("startRunner", () => {
  test("runs requests in queue order and never overlaps children", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-order-"));
    await saveAgentChoice(cwd, { agent: "claude", effort: "high" });
    await appendRequest(cwd, input("First"));
    await appendRequest(cwd, input("Second"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.calls.length === 1);
    expect(spawned.calls[0]?.[0]).toBe("claude");
    expect(spawned.calls[0]?.[1][1]).toBe("prompt for First");
    expect(spawned.calls[0]?.[1]).toEqual(expect.arrayContaining(["--effort", "high"]));
    expect(spawned.calls[0]?.[2]).toEqual({
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    clock.tick();
    expect(spawned.calls).toHaveLength(1);

    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);
    await tickUntil(clock, () => spawned.calls.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("prompt for Second");

    spawned.children[1]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
    expect(clock.clearInterval).toHaveBeenCalledWith("timer");
  });

  test("records a failed request as failed and never retries it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-failed-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    await appendRequest(cwd, input("Broken"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.children.length === 1);
    spawned.children[0]?.close(1);
    await until(() => !runner.snapshot().running);
    const [broken] = await readRequests(cwd);
    expect(broken?.status).toBe("failed");
    // No story in the output, so the verdict is the honest one: the agent ran
    // and exited nonzero, and its last words are in the terminal.
    expect(broken?.failure).toEqual({
      code: "agent-error",
      message: "Codex exited with code 1. Its last output is in the Leglas terminal.",
    });
    expect(runner.snapshot().failedIds).toEqual([broken?.id]);
    clock.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
    await runner.stop();
  });

  test("falls back to codex exec when the persistent app-server is unavailable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-app-server-fallback-"));
    await saveAgentChoice(cwd, { agent: "codex", effort: "high" });
    await appendRequest(cwd, input("Fallback"));
    const clock = manualClock();
    const spawned = spawner();
    const appServer: CodexTurnRunner = {
      warm: async () => {
        throw new Error("unsupported");
      },
      run: async () => {
        throw new Error("unsupported");
      },
      close: async () => {},
    };
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      codexAppServer: appServer,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.calls.length === 1);
    expect(spawned.calls[0]?.[0]).toBe("codex");
    expect(spawned.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["exec", "--json", "model_reasoning_effort=high"]),
    );
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
  });

  test("cancels a persistent run before its synthetic child exists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-start-cancel-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    await appendRequest(cwd, input("Starting"));
    await appendRequest(cwd, input("Next"));
    const clock = manualClock();
    const spawned = spawner();
    let startSignal: AbortSignal | null = null;
    let finishCleanup: (() => void) | null = null;
    const calls: ClaudeTurnInput[] = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const appServer: CodexTurnRunner = {
      warm: async () => {},
      run: (turn, signal) => {
        calls.push(turn);
        if (calls.length > 1) {
          const child = fakeChild();
          children.push(child);
          return Promise.resolve(child.child);
        }
        startSignal = signal ?? null;
        return new Promise((_resolve, reject) => {
          finishCleanup = () => reject(new Error("cancelled after cleanup"));
        });
      },
      close: async () => {},
    };
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      codexAppServer: appServer,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => runner.snapshot().running && startSignal !== null);
    expect(runner.cancel(runner.snapshot().requestId ?? undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.snapshot().stopping).toBe(true);
    expect(calls).toHaveLength(1);

    finishCleanup?.();
    await until(() => !runner.snapshot().running);

    expect(startSignal?.aborted).toBe(true);
    expect(spawned.calls).toHaveLength(0);
    expect((await readRequests(cwd))[0]?.status).toBe("cancelled");
    await tickUntil(clock, () => calls.length === 2);
    children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);
    await runner.stop();
  });

  test("runs Claude through the persistent Agent SDK transport", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-claude-sdk-"));
    await saveAgentChoice(cwd, { agent: "claude", effort: "max" });
    await appendRequest(cwd, input("Persistent"));
    const clock = manualClock();
    const spawned = spawner();
    const calls: ClaudeTurnInput[] = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const sdk: ClaudeTurnRunner = {
      warm: vi.fn(async () => {}),
      run: async (turn) => {
        calls.push(turn);
        const child = fakeChild();
        children.push(child);
        return child.child;
      },
      close: vi.fn(async () => {}),
    };
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      claudeAgentSession: sdk,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => calls.length === 1);
    expect(calls[0]).toEqual({
      prompt: "prompt for Persistent",
      effort: "max",
      sessionId: null,
    });
    expect(spawned.calls).toHaveLength(0);
    children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude_sdk_1" })}\n`,
    );
    children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  test("falls back to claude -p when the Agent SDK is unavailable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-claude-sdk-fallback-"));
    await saveAgentChoice(cwd, { agent: "claude", effort: "xhigh" });
    await appendRequest(cwd, input("Fallback"));
    const clock = manualClock();
    const spawned = spawner();
    const sdk: ClaudeTurnRunner = {
      warm: async () => {
        throw new Error("SDK unavailable");
      },
      run: async () => {
        throw new Error("SDK unavailable");
      },
      close: async () => {},
    };
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      claudeAgentSession: sdk,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.calls.length === 1);
    expect(spawned.calls[0]?.[0]).toBe("claude");
    expect(spawned.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-p", "prompt for Fallback", "--effort", "xhigh"]),
    );
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
  });

  test("yields while an external watcher is attached", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-external-"));
    await saveAgentChoice(cwd, { agent: "cursor" });
    await appendRequest(cwd, input("Waiting"));
    let attached = true;
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => attached,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(0);
    attached = false;
    await tickUntil(clock, () => spawned.calls.length === 1);

    spawned.children[0]?.close(0);
    await runner.stop();
  });

  test("a finished run's session carries into the next request, cold after the cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-session-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    await appendRequest(cwd, input("First"));
    await appendRequest(cwd, input("Second"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.children.length === 1);
    expect(spawned.calls[0]?.[1]).toEqual([
      "exec",
      "--json",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "prompt for First",
    ]);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_1" })}\n`,
    );
    spawned.children[0]?.close(0);

    await until(async () => (await readRequests(cwd)).length === 1);
    await tickUntil(clock, () => spawned.children.length === 2);
    // The second request continues the first one's conversation.
    expect(spawned.calls[1]?.[1]).toEqual([
      "exec",
      "resume",
      "th_1",
      "--json",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--skip-git-repo-check",
      "prompt for Second",
    ]);
    spawned.children[1]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_1" })}\n`,
    );
    spawned.children[1]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
  });

  test("the ninth request starts cold: eight turns is one session's whole life", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-cap-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    for (let turn = 1; turn <= 10; turn += 1) await appendRequest(cwd, input(`Turn ${turn}`));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    for (let turn = 1; turn <= 10; turn += 1) {
      await tickUntil(clock, () => spawned.children.length === turn);
      const argv = spawned.calls[turn - 1]?.[1] ?? [];
      // Turn 1 opens the session, 2 through 8 ride it, 9 hits the cap and
      // opens a fresh one, 10 rides that. The cap is the whole point: an
      // unbounded session makes every request dearer than the last.
      const shouldResume = turn !== 1 && turn !== 9;
      expect([turn, argv[1]]).toEqual([turn, shouldResume ? "resume" : "--json"]);
      const thread = turn <= 8 ? "th_1" : "th_2";
      spawned.children[turn - 1]?.child.stdout.write(
        `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n`,
      );
      spawned.children[turn - 1]?.close(0);
      await until(async () => (await readRequests(cwd)).length === 10 - turn);
    }
    await runner.stop();
  });

  test("a failed resume that never edited retries cold, invisibly to the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-retry-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    await appendRequest(cwd, input("Seed"));
    await appendRequest(cwd, input("Fragile"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.children.length === 1);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_1" })}\n`,
    );
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);

    // The resume dies instantly, the way a vendor-expired session does.
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("resume");
    spawned.children[1]?.close(1);

    // Same request, fresh process, no session: the user never saw a failure.
    await until(() => spawned.children.length === 3);
    expect(spawned.calls[2]?.[1]).toEqual([
      "exec",
      "--json",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "prompt for Fragile",
    ]);
    spawned.children[2]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_2" })}\n`,
    );
    spawned.children[2]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    expect(runner.snapshot().failedIds).toEqual([]);
    await runner.stop();
  });

  test("a resume that edited and then failed is a real failure and ends the session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-poisoned-"));
    await saveAgentChoice(cwd, { agent: "codex" });
    await appendRequest(cwd, input("Seed"));
    await appendRequest(cwd, input("Broken"));
    await appendRequest(cwd, input("After"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.children.length === 1);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_1" })}\n`,
    );
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 2);

    // The resumed run edits a file, then dies. Rerunning could stack a second
    // half-edit on the first, so this must surface as a failure.
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("resume");
    spawned.children[1]?.child.stdout.write(
      `${JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [{ path: "x.html" }] } })}\n`,
    );
    spawned.children[1]?.close(1);
    await until(() => runner.snapshot().failedIds.length === 1);
    expect(spawned.children).toHaveLength(2);

    // The conversation is over: the next request starts cold.
    await tickUntil(clock, () => spawned.children.length === 3);
    expect(spawned.calls[2]?.[1][0]).toBe("exec");
    expect(spawned.calls[2]?.[1][1]).toBe("--json");
    spawned.children[2]?.close(0);
    await runner.stop();
  });

  test("a nudge starts immediately and survives a tick already in flight", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-nudge-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    // The boot tick finds an empty queue and goes idle. The request arrives
    // after it, and the timer never fires in this test: only the nudge can
    // start the run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendRequest(cwd, input("Now"));
    expect(spawned.calls).toHaveLength(0);
    runner.nudge();
    await until(() => spawned.calls.length === 1);
    expect(spawned.calls[0]?.[1][1]).toBe("prompt for Now");

    // While a run is live the nudge is remembered, but nothing overlaps the
    // active child.
    await appendRequest(cwd, input("Later"));
    runner.nudge();
    await appendRequest(cwd, input("Last"));
    runner.nudge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);

    spawned.children[0]?.close(0);
    // No manual clock tick: the remembered nudge starts the queued successor
    // as soon as the first tick settles instead of waiting up to two seconds.
    await until(() => spawned.calls.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("prompt for Later");
    spawned.children[1]?.close(0);
    await until(() => spawned.calls.length === 3);
    expect(spawned.calls[2]?.[1][1]).toBe("prompt for Last");
    spawned.children[2]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();

    // Stopped means stopped: a late nudge must not restart anything, even
    // with work still queued.
    runner.nudge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(3);
  });

  test("cancels the active child with SIGTERM and treats the request as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-cancel-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, input("Cancelled"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => runner.snapshot().running && spawned.children.length === 1);
    expect(runner.snapshot().startedAt).toEqual(expect.any(Number));
    // A stop naming a request that is not the active one is a no-op, so a
    // click aimed at a finished run cannot land on its successor.
    expect(runner.cancel("some-other-request")).toBe(false);
    expect(runner.snapshot().running).toBe(true);
    expect(runner.cancel(runner.snapshot().requestId ?? undefined)).toBe(true);
    expect(spawned.children[0]?.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runner.cancel()).toBe(false);
    await until(() => !runner.snapshot().running);
    expect(runner.snapshot().startedAt).toBeNull();
    expect(runner.cancel()).toBe(false);
    // Written down as stopped, not parked as picked-up: a restart must not
    // read this back as a run still in flight.
    expect((await readRequests(cwd))[0]?.status).toBe("cancelled");

    clock.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
    await runner.stop();
  });

  test("an overloaded provider is not answered with a second cold run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-overload-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, input("Seed"));
    await appendRequest(cwd, input("Poster"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => spawned.children.length === 1);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "s_1" })}\n`,
    );
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);

    // The resume exhausts the vendor's own retry ladder against an overloaded
    // provider: ten attempts, roughly 200 seconds, then a nonzero exit. The
    // session is fine, so the old rule would fire a second cold run and pay
    // the whole ladder again while the provider is still down.
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1]).toContain("--resume");
    spawned.children[1]?.child.stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 10,
        max_retries: 10,
        error_status: 529,
        error: "overloaded",
      })}\n`,
    );
    spawned.children[1]?.close(1);

    await until(() => runner.snapshot().failedIds.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.children).toHaveLength(2);

    const failed = (await readRequests(cwd))[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.code).toBe("provider-overloaded");
    await runner.stop();
  });

  test("a cancelled request is recorded as cancelled, not as a failure to retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-cancel-state-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, input("Poster"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await until(() => runner.snapshot().running);
    expect(runner.cancel()).toBe(true);
    await until(() => !runner.snapshot().running);

    // Written down, so a restart cannot read this back as "your agent is on
    // it" and the interface can say who stopped it.
    const stopped = (await readRequests(cwd))[0];
    expect(stopped?.status).toBe("cancelled");
    expect(stopped?.failure?.code).toBe("cancelled");
    await runner.stop();
  });

  test("a child that will not go is stopped anyway, and the queue moves on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-wedge-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, input("Poster"));
    await appendRequest(cwd, input("Next"));
    const clock = manualClock();
    const spawned = spawner();
    let grace: (() => void) | null = null;
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      setTimeout: (callback, milliseconds) => {
        expect(milliseconds).toBe(5000);
        grace = callback;
      },
    });

    await until(() => spawned.children.length === 1);
    // This child ignores the signal, and its streams never end: a CLI that
    // traps SIGTERM, or a wrapper whose own child outlives it holding the
    // pipe. Nothing will ever emit "close".
    const stubborn = spawned.children[0];
    if (stubborn !== undefined) stubborn.child.kill = vi.fn(() => true);

    expect(runner.cancel()).toBe(true);
    // The card stops claiming a live run immediately, before the child goes.
    expect(runner.snapshot().stopping).toBe(true);
    expect(runner.snapshot().running).toBe(true);

    // Nothing has settled yet, so without an escalation this is where the
    // runner used to stay for the rest of its life.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.snapshot().running).toBe(true);

    grace?.();
    await until(() => !runner.snapshot().running);
    expect(stubborn?.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect((await readRequests(cwd))[0]?.status).toBe("cancelled");

    // And the request queued behind it gets its turn.
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1]).toContain("prompt for Next");
    spawned.children[1]?.close(0);
    await runner.stop();
  });

  test("hands claude the registration allowance on a fork, and only on a fork", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-allow-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, { ...input("Fork"), mode: "variant" });
    await appendRequest(cwd, input("Tweak"));
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      leglasCommand: "npx -y leglas",
    });

    // A fork ends by running the registration CLI, and non-interactive Claude
    // cannot approve a Bash call on its own: without the allowance the
    // mandatory last step is refused, the agent gives up politely, and the
    // run exits 0 having put nothing on the rail.
    await until(() => spawned.children.length === 1);
    const forkArgs = spawned.calls[0]?.[1] ?? [];
    const at = forkArgs.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    expect(forkArgs[at + 1]).toBe("Bash(npx -y leglas add *)");

    await writeFile(join(cwd, LOCAL_PREVIEWS_PATH), `{"previews":[{"x":1}]}`);
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);

    // A change in place is told nothing needs re-registering, so it gets no
    // Bash allowance either.
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1]).not.toContain("--allowedTools");
    spawned.children[1]?.close(0);
    await runner.stop();
  });

  test("a resumed fork carries the registration allowance too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-allow-resume-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, { ...input("First fork"), mode: "variant" });
    await appendRequest(cwd, { ...input("Second fork"), mode: "variant" });
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      leglasCommand: "npx -y leglas",
    });

    await until(() => spawned.children.length === 1);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "s_1" })}\n`,
    );
    await writeFile(join(cwd, LOCAL_PREVIEWS_PATH), `{"previews":[{"x":1}]}`);
    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);

    await tickUntil(clock, () => spawned.children.length === 2);
    const resumed = spawned.calls[1]?.[1] ?? [];
    expect(resumed).toContain("--resume");
    const at = resumed.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    expect(resumed[at + 1]).toBe("Bash(npx -y leglas add *)");
    await runner.stop();
  });

  test("a fork that registers nothing fails instead of vanishing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-unregistered-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    await appendRequest(cwd, { ...input("Fork"), mode: "variant" });
    const clock = manualClock();
    const spawned = spawner();
    const runner = startRunner({
      cwd,
      externallyAttached: () => false,
      spawn: spawned.spawn,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      leglasCommand: "npx -y leglas",
    });

    // The agent says all the right things, exits 0, and never registers.
    // Before the verdict existed this counted as success: the request was
    // removed, the card disappeared, and nothing reached the rail.
    await until(() => spawned.children.length === 1);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: "s_1" })}\n`,
    );
    spawned.children[0]?.close(0);

    await until(() => runner.snapshot().failedIds.length === 1);
    const [fork] = await readRequests(cwd);
    expect(fork?.status).toBe("failed");
    expect(fork?.failure).toEqual({
      code: "not-registered",
      message:
        "Claude finished without registering the new direction, so nothing reached the rail. Its last output is in the Leglas terminal.",
    });

    // The conversation ignored its final instruction, so the session is not
    // trusted with the next request: a fresh fork starts cold.
    await appendRequest(cwd, { ...input("Another fork"), mode: "variant" });
    await tickUntil(clock, () => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1]).not.toContain("--resume");
    spawned.children[1]?.close(0);
    await runner.stop();
  });
});
