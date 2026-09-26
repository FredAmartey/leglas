import { spawn } from "node:child_process";

/**
 * Spawn options that make a process lead its own group, so one signal reaches
 * everything it starts. Not on Windows, which has no groups and gives a
 * detached child its own console.
 */
export function ownGroup(platform: NodeJS.Platform = process.platform) {
  return { detached: platform !== "win32" };
}

export type TreeDeps = {
  platform: NodeJS.Platform;
  kill(pid: number, signal: NodeJS.Signals): void;
  taskkill(pid: number): { once(event: "error", listener: () => void): void };
};

const system: TreeDeps = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  taskkill: (pid) =>
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", shell: false }),
};

/**
 * Signals a process and everything it started, so a dev server, watcher or
 * wrapper's child doesn't outlive it. A negative pid signals the `ownGroup()`
 * group. Windows has no groups, so taskkill walks the tree, forcibly, since a
 * console program can't be asked to close.
 */
export function signalTree(
  child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
  deps: TreeDeps = system,
): void {
  const { pid } = child;

  // It never started, so nothing below it exists.
  if (pid === undefined) {
    child.kill(signal);

    return;
  }

  if (deps.platform === "win32") {
    try {
      deps.taskkill(pid).once("error", () => child.kill(signal));
    } catch {
      child.kill(signal);
    }

    return;
  }

  try {
    deps.kill(-pid, signal);
  } catch {
    // No such group: never made, or already empty.
    child.kill(signal);
  }
}
