import { describe, expect, test, vi } from "vitest";

import { ownGroup, signalTree, type TreeDeps } from "./process-tree.js";

function child(pid: number | undefined) {
  return { pid, kill: vi.fn((_signal: NodeJS.Signals) => true) };
}

function deps(platform: NodeJS.Platform, overrides: Partial<TreeDeps> = {}) {
  const errors: (() => void)[] = [];

  const value: TreeDeps = {
    platform,
    kill: vi.fn(),
    taskkill: vi.fn(() => ({
      once: (_event: "error", listener: () => void) => {
        errors.push(listener);
      },
    })),
    ...overrides,
  };

  return { value, failTaskkill: () => errors.forEach((listener) => listener()) };
}

describe("ownGroup", () => {
  test("leads a group everywhere but Windows, where detaching opens a console", () => {
    expect(ownGroup("darwin")).toEqual({ detached: true });
    expect(ownGroup("linux")).toEqual({ detached: true });
    expect(ownGroup("win32")).toEqual({ detached: false });
  });
});

describe("signalTree", () => {
  test("signals the whole group through a negative pid", () => {
    const agent = child(4242);
    const system = deps("darwin");

    signalTree(agent, "SIGTERM", system.value);

    expect(system.value.kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(agent.kill).not.toHaveBeenCalled();
  });

  test("falls back to the process itself when there is no group to signal", () => {
    const agent = child(4242);

    const system = deps("linux", {
      kill: vi.fn(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }),
    });

    signalTree(agent, "SIGKILL", system.value);

    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("a process that never started is only asked", () => {
    const agent = child(undefined);
    const system = deps("darwin");

    signalTree(agent, "SIGTERM", system.value);

    expect(system.value.kill).not.toHaveBeenCalled();
    expect(agent.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("on Windows taskkill walks the tree, and the process is killed if it cannot", () => {
    const agent = child(4242);
    const system = deps("win32");

    signalTree(agent, "SIGTERM", system.value);

    expect(system.value.taskkill).toHaveBeenCalledWith(4242);
    expect(system.value.kill).not.toHaveBeenCalled();
    expect(agent.kill).not.toHaveBeenCalled();

    system.failTaskkill();
    expect(agent.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
