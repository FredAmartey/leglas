import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type { RestartCommand } from "@leglas/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createHandoff } from "./restart.js";
import { installShutdown, SHUTDOWN_SIGNALS } from "./shutdown.js";

const command: RestartCommand = {
  file: "npx",
  args: ["-y", "leglas@1.1.0", "--port", "4105", "--no-open"],
  shell: false,
};

function harness() {
  const target = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  const spawn = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
  const exit = vi.fn();
  return { child, target, spawn, exit };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

afterEach(() => vi.restoreAllMocks());

describe("handOff", () => {
  test("handoff state belongs to one CLI instance", async () => {
    const first = createHandoff();
    const second = createHandoff();
    const deps = harness();
    expect(first.handedOff()).toBe(false);
    expect(second.handedOff()).toBe(false);
    await first.handOff(command, async () => {}, deps);
    expect(first.handedOff()).toBe(true);
    expect(second.handedOff()).toBe(false);
    deps.child.emit("exit", 0);
  });

  test("marks the handoff before stopping and frees the port before spawning", async () => {
    const deps = harness();
    const { handOff, handedOff } = createHandoff();
    const stopping = deferred();
    const stop = vi.fn(() => stopping.promise);
    const handoff = handOff(command, stop, deps);
    expect(handedOff()).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.spawn).not.toHaveBeenCalled();
    stopping.resolve();
    await handoff;
    expect(deps.spawn).toHaveBeenCalledWith(command.file, command.args, { stdio: "inherit", shell: false });
    deps.child.emit("exit", 0);
  });

  test.each(SHUTDOWN_SIGNALS)("a %s during stop cancels the spawn and exits cleanly", async (signal) => {
    const deps = harness();
    const { handOff } = createHandoff();
    const stopping = deferred();
    const handoff = handOff(command, () => stopping.promise, deps);
    deps.target.emit(signal);
    expect(deps.exit).not.toHaveBeenCalled();
    stopping.resolve();
    await handoff;
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
    for (const name of SHUTDOWN_SIGNALS) expect(deps.target.listenerCount(name)).toBe(0);
  });

  test.each(SHUTDOWN_SIGNALS)("forwards %s to the child while ordinary shutdown stays out", async (signal) => {
    const deps = harness();
    const { handOff, handedOff } = createHandoff();
    const stop = vi.fn(async () => {});
    installShutdown(async () => {
      if (handedOff()) return;
      await stop();
      deps.exit(0);
    }, deps.target);
    await handOff(command, stop, deps);
    deps.target.emit(signal);
    expect(deps.child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.exit).not.toHaveBeenCalled();
    deps.child.emit("exit", 0);
  });

  test.each([[0, null, 0], [7, null, 7], [null, "SIGTERM", 1]] as const)
    ("exits with child code %s and signal %s", async (code, signal, expected) => {
      const deps = harness();
      const { handOff } = createHandoff();
      await handOff(command, async () => {}, deps);
      deps.child.emit("exit", code, signal);
      expect(deps.exit).toHaveBeenCalledExactlyOnceWith(expected);
      for (const name of SHUTDOWN_SIGNALS) expect(deps.target.listenerCount(name)).toBe(0);
    });

  test.each(["throw", "event"])("a spawn %s prints recovery instructions and exits once", async (kind) => {
    const deps = harness();
    const { handOff } = createHandoff();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = new Error("npx could not be found.");
    if (kind === "throw") vi.mocked(deps.spawn).mockImplementation(() => { throw error; });
    await handOff(command, async () => {}, deps);
    if (kind === "event") deps.child.emit("error", error);
    deps.child.emit("exit", 1);
    expect(stderr).toHaveBeenCalledWith("Could not start Leglas again: npx could not be found. Start it from your terminal.\n");
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("a stop failure returns control to ordinary shutdown", async () => {
    const deps = harness();
    const { handOff, handedOff } = createHandoff();
    await expect(handOff(command, async () => { throw new Error("Could not stop the server."); }, deps))
      .rejects.toThrow("Could not stop the server.");
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(handedOff()).toBe(false);
    for (const name of SHUTDOWN_SIGNALS) expect(deps.target.listenerCount(name)).toBe(0);
  });

  test("passes through the Windows shell setting", async () => {
    const deps = harness();
    const { handOff } = createHandoff();
    const windows = { file: 'npx -y leglas@1.1.0 --config "C:\\my app\\config.json"', args: [], shell: true };
    await handOff(windows, async () => {}, deps);
    expect(deps.spawn).toHaveBeenCalledWith(windows.file, [], { stdio: "inherit", shell: true });
    deps.child.emit("exit", 0);
  });
});
