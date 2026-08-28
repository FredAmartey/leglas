import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { BRANCH_IDLE_MS, createBranchRegistry } from "./branches.js";
import type { RunningProxy } from "./proxy.js";
import type { RunningWorktree } from "./worktree.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function running(title = "Wave"): RunningWorktree {
  return {
    branch: `feature/${title.toLowerCase()}`,
    path: `/tmp/${title.toLowerCase()}`,
    port: 4312,
    url: "http://127.0.0.1:4312",
    stop: async () => {},
  };
}

const branch = { title: "Wave", branch: "feature/wave" };

afterEach(() => vi.useRealTimers());

function proxy(options: {
  active?: () => boolean;
  onActivity?: () => void;
  onClose?: () => void;
} = {}): (input: { target: string; onActivity?: () => void }) => Promise<RunningProxy> {
  return async (input) => {
    options.onActivity?.();
    return {
      active: options.active ?? (() => false),
      close: async () => options.onClose?.(),
      url: input.target,
    };
  };
}

describe("branch preview registry", () => {
  test("joins a start already in flight, so one title gets one checkout", async () => {
    const checkout = deferred<RunningWorktree>();
    let starts = 0;
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      startProxy: proxy(),
      startWorktree: async () => {
        starts += 1;
        return checkout.promise;
      },
    });

    const first = registry.start("Wave");
    const second = registry.start("Wave");

    expect(first).toBe(second);
    expect(starts).toBe(1);
    expect(registry.state("Wave")).toEqual({
      status: "starting",
      phase: "checking out",
    });

    const worktree = running();
    checkout.resolve(worktree);
    await first;

    expect(registry.state("Wave")).toEqual({ status: "ready", worktree });
  });

  test("records a failure and lets the next start retry it", async () => {
    let attempts = 0;
    const worktree = running();
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      startProxy: proxy(),
      startWorktree: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("checkout failed");
        return worktree;
      },
    });

    await registry.start("Wave");
    expect(registry.state("Wave")).toEqual({
      status: "failed",
      reason: "checkout failed",
    });

    await registry.start("Wave");
    expect(attempts).toBe(2);
    expect(registry.state("Wave")).toEqual({ status: "ready", worktree });
  });

  test("tracks checkout, install and app startup as coarse phases", async () => {
    const checkout = deferred<RunningWorktree>();
    const states: string[] = [];
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      onChange: (_title, state) => {
        states.push(
          state.status === "starting" ? `${state.status}:${state.phase}` : state.status,
        );
      },
      startProxy: proxy(),
      startWorktree: async (options) => {
        options.onLog?.("installing feature/wave");
        options.onLog?.("vite ready");
        return checkout.promise;
      },
    });

    const start = registry.start("Wave");
    expect(registry.state("Wave")).toEqual({ status: "starting", phase: "starting" });
    checkout.resolve(running());
    await start;

    expect(states).toEqual([
      "starting:checking out",
      "starting:installing",
      "starting:starting",
      "ready",
    ]);
  });

  test("stops every worktree it owns", async () => {
    let stops = 0;
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch, { title: "Ember", branch: "feature/ember" }],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      startProxy: proxy(),
      startWorktree: async ({ branch: name }) => ({
        ...running(name),
        branch: name,
        stop: async () => {
          stops += 1;
        },
      }),
    });

    await Promise.all([registry.start("Wave"), registry.start("Ember")]);
    await registry.stop();

    expect(stops).toBe(2);
  });

  test("stops a ready branch after ten minutes without proxy activity, then lets it start again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let starts = 0;
    let proxyStops = 0;
    let worktreeStops = 0;
    const checkout = join(mkdtempSync(join(tmpdir(), "leglas-idle-")), "wave");
    mkdirSync(checkout);
    const transitions: string[] = [];
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      onChange: (_title, state) => transitions.push(state.status),
      startProxy: proxy({ onClose: () => (proxyStops += 1) }),
      startWorktree: async () => {
        starts += 1;
        return {
          ...running(),
          path: checkout,
          stop: async () => {
            worktreeStops += 1;
            rmSync(checkout, { recursive: true, force: true });
          },
        };
      },
    });

    await registry.start("Wave");
    await vi.advanceTimersByTimeAsync(BRANCH_IDLE_MS + 30_000);

    expect(proxyStops).toBe(1);
    expect(worktreeStops).toBe(1);
    expect(existsSync(checkout)).toBe(false);
    expect(registry.state("Wave")).toEqual({ status: "idle" });
    expect(transitions.at(-1)).toBe("idle");

    await registry.start("Wave");
    expect(starts).toBe(2);
    expect(registry.state("Wave")?.status).toBe("ready");
    await registry.stop();
  });

  test("does not stop a branch that still has an active proxy connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let active = true;
    let stops = 0;
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      startProxy: proxy({ active: () => active }),
      startWorktree: async () => ({
        ...running(),
        stop: async () => {
          stops += 1;
        },
      }),
    });

    await registry.start("Wave");
    await vi.advanceTimersByTimeAsync(BRANCH_IDLE_MS * 2);

    expect(stops).toBe(0);
    expect(registry.state("Wave")?.status).toBe("ready");

    active = false;
    await vi.advanceTimersByTimeAsync(BRANCH_IDLE_MS + 30_000);
    expect(stops).toBe(1);
    expect(registry.state("Wave")).toEqual({ status: "idle" });
    await registry.stop();
  });

  test("never stops a branch while it is starting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const checkout = deferred<RunningWorktree>();
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
      startProxy: proxy(),
      startWorktree: async () => checkout.promise,
    });

    const start = registry.start("Wave");
    await vi.advanceTimersByTimeAsync(BRANCH_IDLE_MS * 2);

    expect(registry.state("Wave")?.status).toBe("starting");

    checkout.resolve(running());
    await start;
    expect(registry.state("Wave")?.status).toBe("ready");
    await registry.stop();
  });
});
