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

export type RunningApp = {
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

/** Loopback, both ways round, because a dev server picks one of them. */
const LOOPBACK = ["127.0.0.1", "::1"] as const;

/** An address for a URL: IPv6 needs the brackets, IPv4 must not have them. */
function forUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * The loopback address answering on this port, or null while none does.
 *
 * Which one that is cannot be assumed. A dev command told to serve `localhost`
 * binds whatever the machine resolves that to, and on current macOS and Node
 * it is `::1` first: Vite's default listens on IPv6 alone. Probing only
 * `127.0.0.1` therefore waits out the whole deadline against a server that has
 * been answering since its first second, and then blames the user's dev
 * command for not serving the port it was given, which it did.
 *
 * The answer is also what the URL has to be built from. Reporting
 * `127.0.0.1` for a server bound to `::1` hands the interface an address
 * nothing is listening on, which fails later and further from the cause.
 */
async function answeringHost(port: number): Promise<string | null> {
  const reached = await Promise.all(
    LOOPBACK.map(
      (host) =>
        new Promise<string | null>((resolve) => {
          const socket = net.connect({ port, host });
          const settle = (value: string | null) => {
            socket.destroy();
            resolve(value);
          };
          socket.setTimeout(400);
          socket.once("connect", () => settle(host));
          socket.once("timeout", () => settle(null));
          socket.once("error", () => settle(null));
        }),
    ),
  );
  return reached.find((host) => host !== null) ?? null;
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

  try {
    const app = await startAppProcess({
      cwd: path,
      devCommand: options.devCommand,
      label: options.branch,
      readyTimeoutMs,
      onLog: log,
    });
    return {
      branch: options.branch,
      path,
      port: app.port,
      url: app.url,
      stop: async () => {
        await app.stop();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Start a dev server with its command and wait until it answers.
 *
 * Shared by the two places Leglas owns an app process: a worktree checkout,
 * and the project's own app when nothing is listening and the config says how
 * to start one (the greenfield case).
 */
export async function startAppProcess(options: {
  cwd: string;
  devCommand: string;
  /** How the process is named in errors: a branch, or "your app". */
  label: string;
  readyTimeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<RunningApp> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const log = options.onLog ?? (() => {});

  const port = await freePort();
  let child: ChildProcess;
  try {
    child = spawn(substitutePort(options.devCommand, port), {
      cwd: options.cwd,
      shell: true,
      // Own process group, so stopping kills the shell and whatever it spawned
      // rather than orphaning a dev server holding the port.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Could not start ${options.label}: ${error instanceof Error ? error.message : String(error)}`,
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
  };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `${options.label} did not start: its dev command exited with code ${exited}.`,
      );
    }
    const host = await answeringHost(port);
    if (host !== null) {
      return { port, url: `http://${forUrl(host)}:${port}`, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stop();
  throw new Error(
    `${options.label} did not start within ${Math.round(readyTimeoutMs / 1000)}s. ` +
      `Check that its dev command serves the port it is given.`,
  );
}
