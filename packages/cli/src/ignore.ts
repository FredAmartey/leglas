/** Everything Leglas writes into a project lives here, and none of it is shared. */
export const IGNORED = ".leglas/";

/**
 * The .gitignore contents needed to ignore Leglas's working directory, or null
 * when nothing needs to change.
 *
 * Any command that writes into `.leglas/` calls this, because the moment the
 * directory exists un-ignored, someone's exploration is one `git add -A` away
 * from a commit.
 */
export function ignoreEntry(current: string | null): string | null {
  const lines = (current ?? "").split("\n").map((line) => line.trim());
  if (lines.some((line) => line === IGNORED || line === ".leglas")) return null;

  const body = (current ?? "").replace(/\n*$/, "");
  const preamble = body === "" ? "" : `${body}\n\n`;
  return `${preamble}# Leglas exploration: variant code, caches, logs.\n${IGNORED}\n`;
}
