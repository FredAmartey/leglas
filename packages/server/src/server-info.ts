import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isNumber, isString, isJsonRecord, parseJson } from "./json.js";

/** The running server's small rendezvous record for commands in another process. */
export const SERVER_INFO_PATH = ".leglas/server.json";

export type ServerInfo = { port: number; url: string; pid: number };

/**
 * Writes the record, only through our own file. Leglas writes this path
 * unasked, so a link in its place or in `.leglas` is refused, not followed.
 * Written to a temporary file and renamed, so a reader never sees half a
 * record.
 */
export async function writeServerInfo(cwd: string, info: ServerInfo): Promise<void> {
  const path = join(cwd, SERVER_INFO_PATH);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  if (!(await lstat(directory)).isDirectory()) return;
  const existing = await lstat(path).catch(() => null);

  if (existing !== null && !existing.isFile()) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...info, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, path).catch(async (cause: unknown) => {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  });
}

export async function readServerInfo(cwd: string): Promise<ServerInfo | null> {
  try {
    const value = parseJson(await readFile(join(cwd, SERVER_INFO_PATH), "utf8"));

    if (
      !isJsonRecord(value) ||
      !isNumber(value.port) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      !isString(value.url) ||
      value.url === "" ||
      !isNumber(value.pid) ||
      !Number.isInteger(value.pid)
    )
      return null;

    return { port: value.port, url: value.url, pid: value.pid };
  } catch {
    return null;
  }
}

/**
 * Removes the record, but only the one this server wrote. Two Leglas processes
 * can serve one project; the earlier one closing must not take the newer
 * record, or `show --screenshot` loses a running server. With no expectation,
 * the file goes regardless.
 */
export async function removeServerInfo(
  cwd: string,
  expected?: { port: number; pid: number },
): Promise<void> {
  if (expected !== undefined) {
    const current = await readServerInfo(cwd);

    if (current !== null && (current.port !== expected.port || current.pid !== expected.pid))
      return;
  }

  await rm(join(cwd, SERVER_INFO_PATH), { force: true });
}
