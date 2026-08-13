import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveAgentChoice } from "./agents.js";
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

afterEach(() => vi.restoreAllMocks());

describe("startRunner", () => {
  test("runs requests in queue order and never overlaps children", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-order-"));
    await saveAgentChoice(cwd, { agent: "claude" });
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
    expect(spawned.calls[0]?.[2]).toEqual({
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    clock.tick();
    expect(spawned.calls).toHaveLength(1);

    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);
    clock.tick();
    await until(() => spawned.calls.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("prompt for Second");

    spawned.children[1]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 0);
    await runner.stop();
    expect(clock.clearInterval).toHaveBeenCalledWith("timer");
  });

  test("keeps a failed request picked-up and never retries it", async () => {
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
    expect((await readRequests(cwd))[0]?.status).toBe("picked-up");
    expect(runner.snapshot().failedIds).toEqual([
      (await readRequests(cwd))[0]?.id,
    ]);
    clock.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
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
    clock.tick();
    await until(() => spawned.calls.length === 1);

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
      "-s",
      "workspace-write",
      "prompt for First",
    ]);
    spawned.children[0]?.child.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: "th_1" })}\n`,
    );
    spawned.children[0]?.close(0);

    await until(async () => (await readRequests(cwd)).length === 1);
    clock.tick();
    await until(() => spawned.children.length === 2);
    // The second request continues the first one's conversation.
    expect(spawned.calls[1]?.[1]).toEqual([
      "exec",
      "resume",
      "th_1",
      "--json",
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
      await until(() => spawned.children.length === turn);
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
      clock.tick();
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
    clock.tick();

    // The resume dies instantly, the way a vendor-expired session does.
    await until(() => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("resume");
    spawned.children[1]?.close(1);

    // Same request, fresh process, no session: the user never saw a failure.
    await until(() => spawned.children.length === 3);
    expect(spawned.calls[2]?.[1]).toEqual([
      "exec",
      "--json",
      "-s",
      "workspace-write",
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
    clock.tick();

    // The resumed run edits a file, then dies. Rerunning could stack a second
    // half-edit on the first, so this must surface as a failure.
    await until(() => spawned.children.length === 2);
    expect(spawned.calls[1]?.[1][1]).toBe("resume");
    spawned.children[1]?.child.stdout.write(
      `${JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [{ path: "x.html" }] } })}\n`,
    );
    spawned.children[1]?.close(1);
    await until(() => runner.snapshot().failedIds.length === 1);
    expect(spawned.children).toHaveLength(2);

    // The conversation is over: the next request starts cold.
    clock.tick();
    await until(() => spawned.children.length === 3);
    expect(spawned.calls[2]?.[1][0]).toBe("exec");
    expect(spawned.calls[2]?.[1][1]).toBe("--json");
    spawned.children[2]?.close(0);
    await runner.stop();
  });

  test("a nudge starts a queued request without waiting for the poll", async () => {
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

    // While a run is live a nudge is swallowed whole: the tick in flight
    // already owns the queue, so nothing can overlap it.
    await appendRequest(cwd, input("Later"));
    runner.nudge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);

    spawned.children[0]?.close(0);
    await until(async () => (await readRequests(cwd)).length === 1);
    await runner.stop();

    // Stopped means stopped: a late nudge must not restart anything, even
    // with work still queued.
    runner.nudge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
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
    expect((await readRequests(cwd))[0]?.status).toBe("picked-up");

    clock.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
    await runner.stop();
  });
});
