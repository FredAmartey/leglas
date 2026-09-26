import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isJsonRecord, parseJson } from "../json.js";

/**
 * What a direction is called on this machine when that differs from its config
 * title. Rail renames can't go back into leglas.config.ts, since Leglas doesn't
 * edit files it didn't write, so they live here and every command resolves
 * through them. Otherwise the CLI answers a name its own interface taught with
 * "no direction called that". Keyed by config title, which a rename can't
 * change.
 */
export const RENAMES_PATH = ".leglas/renames.json";

export type Renames = Record<string, string>;

export async function readRenames(cwd: string): Promise<Renames> {
  try {
    const raw = await readFile(join(cwd, RENAMES_PATH), "utf8");
    const parsed = parseJson(raw);

    if (!isJsonRecord(parsed) || (!isJsonRecord(parsed.renames) && !Array.isArray(parsed.renames)))
      return {};

    // Anything but a string pair is dropped: a browser writes this and commands
    // acting on real source read it.
    return Object.fromEntries(
      Object.entries(parsed.renames).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
  } catch {
    // Nothing renamed, or unreadable; the config titles still work.
    return {};
  }
}

/** Replace the whole map, which is how the interface holds it. */
export async function writeRenames(cwd: string, renames: Renames): Promise<void> {
  const path = join(cwd, RENAMES_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ renames }, null, 2)}\n`, "utf8");
}

export type TitleResolution =
  | { ok: true; title: string }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; matches: string[] };

/**
 * Turns a typed name into the config title commands use. A config title always
 * wins, even over a local rename to the same word, since teammates see the
 * config. Two directions renamed to one word is refused, since a guess edits
 * the wrong one.
 */
export function resolveTitle(
  input: string,
  titles: readonly string[],
  renames: Renames,
): TitleResolution {
  if (titles.includes(input)) return { ok: true, title: input };

  const matches = titles.filter((title) => renames[title] === input);

  if (matches.length === 1 && matches[0] !== undefined) return { ok: true, title: matches[0] };

  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };

  return { ok: false, reason: "unknown" };
}
