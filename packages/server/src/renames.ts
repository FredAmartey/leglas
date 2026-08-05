import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * What a direction is called on this machine, when that differs from its title
 * in the config.
 *
 * Renaming happens in the rail, and the name that comes out of it is the one
 * the user then says out loud: "make Sunrise warmer". Leglas cannot write that
 * back into leglas.config.ts, because it does not edit files it did not write.
 * So the name lives here instead, beside the other machine-local state, and
 * every command resolves through it. Without this, the CLI answers a name its
 * own interface taught the user with "no direction called that", and an agent
 * following that answer concludes the direction is gone.
 *
 * Keyed by config title, because that is the identity everything else uses and
 * the one thing a rename cannot change.
 */
export const RENAMES_PATH = ".leglas/renames.json";

export type Renames = Record<string, string>;

export async function readRenames(cwd: string): Promise<Renames> {
  try {
    const raw = await readFile(join(cwd, RENAMES_PATH), "utf8");
    const parsed = JSON.parse(raw) as { renames?: unknown };
    if (parsed.renames === null || typeof parsed.renames !== "object") return {};
    // Anything not a string pair is dropped rather than trusted: this file is
    // written by a browser and read by commands that act on real source.
    return Object.fromEntries(
      Object.entries(parsed.renames as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
  } catch {
    // Never renamed anything, or the file is unreadable. Neither is worth
    // reporting: the config titles still work.
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
 * Turn whatever name someone typed into the config title commands address by.
 *
 * A config title always wins, even when another direction has been renamed to
 * that same word: the shared config is what a teammate sees, and a local
 * nickname must not shadow it. Only then are the local names considered, and
 * two directions renamed to one word is refused rather than guessed at, since
 * guessing here edits the wrong direction.
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
