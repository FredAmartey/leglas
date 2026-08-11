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
    expect(runner.cancel()).toBe(true);
    expect(spawned.children[0]?.child.kill).toHaveBeenCalledWith("SIGTERM");
    await until(() => !runner.snapshot().running);
    expect(runner.cancel()).toBe(false);
    expect((await readRequests(cwd))[0]?.status).toBe("picked-up");

    clock.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.calls).toHaveLength(1);
    await runner.stop();
  });
});
