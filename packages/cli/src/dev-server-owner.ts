import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const INSPECTION_TIMEOUT_MS = 750;

export type DevServerOwner = {
  pid: number;
  cwd: string;
};

/** Only localhost origins can be tied safely to a process on this machine. */
export function localDevServerPort(origin: string): number | null {
  try {
    const url = new URL(origin);
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export function parseListeningPids(output: string): number[] {
  return [...new Set(output.split("\n").flatMap((line) => {
    if (!/^p\d+$/.test(line)) return [];
    return [Number(line.slice(1))];
  }))];
}

export function parseOwnerCwds(output: string): DevServerOwner[] {
  const owners: DevServerOwner[] = [];
  let pid: number | null = null;
  let cwdRecord = false;

  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
      cwdRecord = false;
    } else if (line === "fcwd") {
      cwdRecord = true;
    } else if (cwdRecord && line.startsWith("n") && pid !== null) {
      owners.push({ pid, cwd: line.slice(1) });
      cwdRecord = false;
    }
  }

  return owners;
}

/**
 * Read the working directory of the process listening on a local dev-server
 * port. This is best-effort by design: unsupported platforms, missing lsof,
 * permissions and a process exiting mid-read all mean "no evidence", not a
 * failed Leglas startup.
 */
export async function inspectLocalDevServer(origin: string): Promise<DevServerOwner[]> {
  const port = localDevServerPort(origin);
  if (port === null || process.platform === "win32") return [];

  try {
    const listeners = await run(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { maxBuffer: 64 * 1024, timeout: INSPECTION_TIMEOUT_MS },
    );
    const pids = parseListeningPids(String(listeners.stdout));
    if (pids.length === 0) return [];

    const directories = await run(
      "lsof",
      ["-nP", "-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"],
      { maxBuffer: 64 * 1024, timeout: INSPECTION_TIMEOUT_MS },
    );
    const owners = parseOwnerCwds(String(directories.stdout));
    return await Promise.all(
      owners.map(async (owner) => ({
        ...owner,
        cwd: await realpath(owner.cwd).catch(() => resolve(owner.cwd)),
      })),
    );
  } catch {
    return [];
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** A short, actionable warning only when every discovered owner is unrelated. */
export function devServerOwnerWarning(
  origin: string,
  projectRoot: string,
  owners: readonly DevServerOwner[],
): string | null {
  const port = localDevServerPort(origin);
  if (port === null || owners.length === 0) return null;
  if (owners.some((owner) => isInside(projectRoot, owner.cwd))) return null;

  const owner = basename(resolve(owners[0]?.cwd ?? "")) || "another project";
  const project = basename(resolve(projectRoot)) || "this project";
  return (
    `Port ${port} appears to be served from ${owner}, outside this project (${project}). ` +
    "Check devServer in your Leglas config or use --user-port."
  );
}
