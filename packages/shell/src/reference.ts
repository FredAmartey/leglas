import type { Preview } from "./types.js";

/**
 * What the clipboard carries when a direction is copied.
 *
 * It used to carry a bare preview URL, which is close to useless to both
 * readers it might reach. A teammate gets a localhost address that resolves on
 * nobody's machine but yours; an agent gets an opaque string it cannot see and
 * cannot act on. Neither learns which direction you meant.
 *
 * So the block says what the direction is, where its source lives, and how to
 * pull up the rest of the comparison. The title comes first because that is
 * the identity every command takes: `leglas add`, `leglas keep` and
 * `leglas explore --based-on` all address a direction by its config title, and
 * a name given in the rail is decoration on top of it. When the two differ,
 * both are printed rather than the one you happen to be looking at.
 *
 * The source line is the part an agent actually uses. A file-backed direction
 * names its file, a branch-backed one names its branch, and an ordinary one
 * names the route its own app resolves. All three are project-relative, so
 * nothing here leaks the shape of the machine it was copied on.
 */
export type ReferenceInput = {
  displayName: string;
  preview: Preview | undefined;
  /** Absolute, ready to paste into a browser. */
  previewUrl: string;
  title: string;
};

/**
 * A preview URL may be root-relative or already absolute — a branch preview
 * runs on its own port, and a config may point at a staging host — so the
 * origin is a base to resolve against, never a prefix to concatenate.
 */
export function absoluteUrl(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString();
  } catch {
    return url;
  }
}

export function referenceText({
  displayName,
  preview,
  previewUrl,
  title,
}: ReferenceInput): string {
  const shownAs = displayName === title ? "" : ` (shown as ${JSON.stringify(displayName)})`;
  const note = preview?.note ? ` — ${preview.note}` : "";
  const tags = preview?.tags.length ? ` [${preview.tags.join(", ")}]` : "";

  const lines = [`Leglas direction ${JSON.stringify(title)}${shownAs}${note}${tags}`];
  if (preview?.file) lines.push(`Source: ${preview.file}`);
  else if (preview?.branch) lines.push(`Branch: ${preview.branch}`);
  else if (preview) lines.push(`Route: ${preview.url}`);
  lines.push(`Preview: ${previewUrl}`);
  if (preview?.basedOn) lines.push(`A shade of: ${preview.basedOn}`);

  // The set matters as much as the one direction: comparing is the whole point,
  // and an agent handed a single direction has no idea what it is up against.
  lines.push("", "Everything being compared:", "  leglas list --json");
  return lines.join("\n");
}
