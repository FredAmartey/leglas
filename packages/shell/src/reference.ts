import type { Preview } from "./types.js";

/**
 * What the clipboard carries when a direction is copied. A bare preview URL was
 * useless: a localhost address for a teammate, an opaque string for an agent.
 * The block says what the direction is, where its source lives and how to get
 * the rest.
 *
 * The config title leads, since every command (`leglas add`, `leglas keep`,
 * `leglas explore --based-on`) takes it; a rail name differing from it is
 * printed too. The source line is what an agent uses: a file, a branch or the
 * app route, all project-relative so nothing reveals the machine.
 */
export type ReferenceInput = {
  displayName: string;
  preview: Preview | undefined;
  /** Absolute, ready to paste into a browser. */
  previewUrl: string;
  title: string;
};

/**
 * A preview URL may already be absolute (a branch on its own port, a staging
 * host), so the origin is a base to resolve against, never a prefix.
 */
export function absoluteUrl(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString();
  } catch {
    return url;
  }
}

export function referenceText({ displayName, preview, previewUrl, title }: ReferenceInput): string {
  const shownAs = displayName === title ? "" : ` (shown as ${JSON.stringify(displayName)})`;
  const note = preview?.note ? ` — ${preview.note}` : "";
  const tags = preview?.tags.length ? ` [${preview.tags.join(", ")}]` : "";

  const lines = [`Leglas direction ${JSON.stringify(title)}${shownAs}${note}${tags}`];

  if (preview?.file) lines.push(`Source: ${preview.file}`);
  else if (preview?.branch) lines.push(`Branch: ${preview.branch}`);
  else if (preview) lines.push(`Route: ${preview.url}`);
  lines.push(`Preview: ${previewUrl}`);

  if (preview?.basedOn) lines.push(`A variant of: ${preview.basedOn}`);

  // What the block can't carry: the source file, and the set it's judged
  // against (so an agent doesn't improve it out of the comparison). Both come
  // from show, so one pointer covers them, quoted with the config title every
  // command addresses.
  lines.push(
    "",
    "Inspect this direction in full:",
    `  npx leglas show ${JSON.stringify(title)} --json`,
  );

  return lines.join("\n");
}
