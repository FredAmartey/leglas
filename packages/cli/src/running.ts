import { realpath } from "node:fs/promises";

import { DEFAULT_PORT, LEGLAS_PREFIX, readServerInfo } from "@leglas/server";

import { bodyOf, isJsonObject, isString, type JsonValue } from "./json.js";

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
 * The Leglas serving this project: an explicit port, else the server's record,
 * else the default (a record can be missing while a server is up). Health
 * decides either way, and a Leglas serving another project is refused.
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

/**
 * The interface on one direction, or two side by side; none opens the rail.
 * On localhost, like the address Leglas opens, because the rail keeps its
 * layout per origin.
 */
export function interfaceUrl(port: number, titles: readonly string[]): string {
  const url = new URL(`http://localhost:${port}${LEGLAS_PREFIX}`);
  const [direction, compare] = titles;

  if (direction !== undefined) url.searchParams.set("direction", direction);

  if (compare !== undefined) url.searchParams.set("compare", compare);

  return url.href;
}

/**
 * The titles on the rail a running Leglas serves, as its interface reads them.
 * They can differ from the files: a branch or file direction registered while
 * it runs joins only after a restart.
 */
export async function railTitles(
  port: number,
  request: typeof fetch,
): Promise<ReadonlySet<string> | null> {
  try {
    const response = await request(`http://127.0.0.1:${port}${LEGLAS_PREFIX}/api/config`, {
      signal: AbortSignal.timeout(2_000),
    });

    if (!response.ok) return null;
    const payload = await bodyOf(response);

    if (!isJsonObject(payload) || !Array.isArray(payload.previews)) return null;

    return new Set(
      payload.previews.flatMap((preview) =>
        isJsonObject(preview) && isString(preview.title) ? [preview.title] : [],
      ),
    );
  } catch {
    return null;
  }
}

export type Rail = { port: number; titles: ReadonlySet<string> };

/**
 * This project's running rail, known only from the record its server writes:
 * without one there is no link to give, and nothing is asked.
 */
export async function recordedRail(cwd: string, request: typeof fetch): Promise<Rail | null> {
  const record = await readServerInfo(cwd);

  if (record === null) return null;
  const found = await findLeglas(cwd, record.port, request);

  if (!found.ok) return null;
  const titles = await railTitles(found.port, request);

  return titles === null ? null : { port: found.port, titles };
}
