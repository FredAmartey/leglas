import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The running server's small rendezvous record for commands in another process. */
export const SERVER_INFO_PATH = ".leglas/server.json";

export type ServerInfo = { port: number; url: string; pid: number };

/**
 * Write the record, refusing to write through anything but our own file.
 *
 * Starting Leglas writes this path without being asked, which makes it a
 * standing offer to overwrite whatever it points at. A link in its place, or
 * in `.leglas` itself, is left alone instead of followed. The write goes to a
 * temporary file first and is renamed into place, so a reader never sees half
 * a record.
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
  await rename(temporary, path).catch(async (error: unknown) => {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  });
}

export async function readServerInfo(cwd: string): Promise<ServerInfo | null> {
  try {
    const value = JSON.parse(await readFile(join(cwd, SERVER_INFO_PATH), "utf8")) as Partial<ServerInfo>;
    if (
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.url !== "string" ||
      value.url === "" ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid)
    ) return null;
    return { port: value.port, url: value.url, pid: value.pid };
  } catch {
    return null;
  }
}

/**
 * Remove the record, but only the one this server wrote.
 *
 * Two Leglas processes can serve one project, and the later one overwrites
 * the file. The earlier one closing must not take the newer record with it,
 * or `show --screenshot` loses a server that is still running. With no
 * expectation given the file goes regardless, which is what a test wants.
 */
export async function removeServerInfo(
  cwd: string,
  expected?: { port: number; pid: number },
): Promise<void> {
  if (expected !== undefined) {
    const current = await readServerInfo(cwd);
    if (current !== null && (current.port !== expected.port || current.pid !== expected.pid)) return;
  }
  await rm(join(cwd, SERVER_INFO_PATH), { force: true });
}
