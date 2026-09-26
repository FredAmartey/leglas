/** Everything Leglas writes into a project lives here, and none of it is shared. */
export const IGNORED = ".leglas/";

/**
 * The .gitignore contents that ignore `.leglas/`, or null when nothing needs to
 * change. Every command that writes there calls this; un-ignored, an
 * exploration is one `git add -A` from a commit.
 */
export function ignoreEntry(current: string | null): string | null {
  const lines = (current ?? "").split("\n").map((line) => line.trim());

  if (lines.some((line) => line === IGNORED || line === ".leglas")) return null;

  const body = (current ?? "").replace(/\n*$/, "");
  const preamble = body === "" ? "" : `${body}\n\n`;

  return `${preamble}# Leglas exploration: variant code, caches, logs.\n${IGNORED}\n`;
}
