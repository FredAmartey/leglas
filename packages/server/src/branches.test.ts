import { describe, expect, test } from "vitest";

import { createBranchRegistry } from "./branches.js";
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

describe("branch preview registry", () => {
  test("joins a start already in flight, so one title gets one checkout", async () => {
    const checkout = deferred<RunningWorktree>();
    let starts = 0;
    const registry = createBranchRegistry({
      cwd: "/repo",
      previews: [branch],
      installCommand: "pnpm install",
      devCommand: "pnpm dev --port {port}",
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
});
