import { realpath } from "node:fs/promises";

import { DEFAULT_PORT, readServerInfo } from "@leglas/server";

import { isJsonObject, isString, type JsonValue } from "./json.js";

export const NOT_RUNNING = "Leglas is not running here. Start it with npx leglas, then try again.";

/** Two paths that name one directory, whatever symlinks sit in the way. */
async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(left).catch(() => left),
    realpath(right).catch(() => right),
  ]);

  return a === b;
}

export type FoundLeglas = { ok: true; port: number; base: string } | { ok: false; error: string };

/**
 * The Leglas serving this project, for a command that needs the running one.
 *
 * An explicit port wins; then the record the running server wrote; then the
 * default, since a record can be missing while a server is up (two servers on
 * one project, the newer one gone first). The health answer decides whichever
 * way the port was found, and a Leglas serving another project is not this
 * one: acting on it would act on the wrong project's directions.
 */
export async function findLeglas(
  cwd: string,
  port: number | null,
  request: typeof fetch,
): Promise<FoundLeglas> {
  const server = port === null ? await readServerInfo(cwd) : null;
  const chosen = port ?? server?.port ?? DEFAULT_PORT;

  try {
    const health = await request(`http://127.0.0.1:${chosen}/leglas/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });

    if (health.status !== 200) return { ok: false, error: NOT_RUNNING };

    // A body that is not JSON is carried on as before: not proof of another project.
    const answered = await health
      .text()
      .then((text): JsonValue => JSON.parse(text))
      .catch((): JsonValue => ({}));

    if (answered === null) return { ok: false, error: NOT_RUNNING };

    if (
      isJsonObject(answered) &&
      isString(answered.cwd) &&
      !(await sameDirectory(answered.cwd, cwd))
    ) {
      return {
        ok: false,
        error: `The Leglas on port ${chosen} serves another project. Start one here with npx leglas, or name the right one with --port.`,
      };
    }

    return { ok: true, port: chosen, base: `http://127.0.0.1:${chosen}` };
  } catch {
    return { ok: false, error: NOT_RUNNING };
  }
}
