import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const WORKTREES_DIR = ".leglas/worktrees";

/** How long a checkout gets to install before that is treated as the failure. */
const INSTALL_TIMEOUT_MS = 300_000;

export type RunningWorktree = {
  branch: string;
  path: string;
  port: number;
  url: string;
  stop(): Promise<void>;
};

/** A branch name flattened into one directory name. */
export function worktreeSlug(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function substitutePort(command: string, port: number): string {
  return command.split("{port}").join(String(port));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * Bring up a preview of another branch.
 *
 * Isolation is the exception, not the default: a direction that can live in the
 * running app should, because that is what makes switching instant. This exists
 * for the cases that genuinely cannot, of which comparing two branches is the
 * clearest, since it is inexpressible any other way.
 *
 * The checkout is detached rather than a branch checkout, so previewing a branch
 * never collides with the same branch being checked out in the user's own
 * working tree.
 */
export async function startWorktree(options: {
  cwd: string;
  branch: string;
  installCommand: string;
  devCommand: string;
  readyTimeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<RunningWorktree> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const path = join(options.cwd, WORKTREES_DIR, worktreeSlug(options.branch));
  const log = options.onLog ?? (() => {});

  await rm(path, { recursive: true, force: true });
  // Prune first: a previous run killed mid-flight leaves a stale registration
  // that would make this add fail for a reason the user cannot act on.
  await run("git", ["worktree", "prune"], { cwd: options.cwd }).catch(() => {});

  try {
    await run("git", ["worktree", "add", "--detach", path, options.branch], { cwd: options.cwd });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not check out ${options.branch}: ${detail.split("\n").slice(-2).join(" ").trim()}`,
    );
  }

  const cleanup = async () => {
    await run("git", ["worktree", "remove", "--force", path], { cwd: options.cwd }).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
  };

  try {
    log(`installing ${options.branch}`);
    await run(options.installCommand, {
      cwd: path,
      shell: true,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    await cleanup();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Install failed in ${options.branch}: ${detail.split("\n")[0]}`);
  }

  const port = await freePort();
  let child: ChildProcess;
  try {
    child = spawn(substitutePort(options.devCommand, port), {
      cwd: path,
      shell: true,
      // Own process group, so stopping kills the shell and whatever it spawned
      // rather than orphaning a dev server holding the port.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await cleanup();
    throw new Error(
      `Could not start ${options.branch}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? 0;
  });
  child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
  child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));

  const stop = async () => {
    try {
      if (child.pid !== undefined && exited === null) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await cleanup();
  };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      await cleanup();
      throw new Error(
        `${options.branch} did not start: its dev command exited with code ${exited}.`,
      );
    }
    if (await answers(port)) {
      return { branch: options.branch, path, port, url: `http://127.0.0.1:${port}`, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stop();
  throw new Error(
    `${options.branch} did not start within ${Math.round(readyTimeoutMs / 1000)}s. ` +
      `Check that its dev command serves the port it is given.`,
  );
}
