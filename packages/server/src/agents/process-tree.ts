import { spawn } from "node:child_process";

/**
 * Spawn options that make a process the leader of its own group, so one
 * signal can reach everything it starts. Not on Windows, which has no process
 * groups and where a detached child opens a console window of its own.
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
 * Signal a process and everything it started.
 *
 * Signalling the process alone leaves whatever it launched running: a dev
 * server holding its port, a watcher still writing files, a wrapper's child
 * holding the output pipe open after the wrapper has gone. Spawned with
 * `ownGroup()`, the process leads a group its descendants join, and a
 * negative pid signals the whole group. Windows has no groups, so taskkill
 * walks the tree instead, and forcibly, because a console program cannot be
 * asked to close.
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
    // No such group: it was never made, or everything in it has gone.
    child.kill(signal);
  }
}
