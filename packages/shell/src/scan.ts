import type { Preview } from "./types.js";

/** Remove one stale verdict while preserving every unrelated preview. */
export function forgetSignature(
  signatures: Readonly<Record<string, string | null>>,
  title: string,
): Record<string, string | null> {
  if (!(title in signatures)) return signatures;
  const next = { ...signatures };
  delete next[title];
  return next;
}

/**
 * Which previews still need a background read for the duplicate check.
 *
 * Signatures used to come only from panes the user had opened, so the "Same
 * as" tag trickled in one click at a time and the warning arrived after the
 * judgment it was meant to protect. Every readable preview is now read off
 * stage at one fixed viewport, one at a time, so the verdict is both complete
 * and independent of the visible stage size.
 *
 * Only previews this page can read qualify: a relative url renders
 * same-origin through the proxy or a file mount, while an absolute url is
 * another origin whose document is sealed, and those go uncompared exactly as
 * before. Previews with a recorded signature are done, even when the record
 * is null: null means "drew nothing worth comparing", and rereading it every
 * cycle would scan forever.
 */
export function scanQueue(
  previews: readonly Preview[],
  signatures: Readonly<Record<string, string | null>>,
): string[] {
  return previews
    .filter((preview) => {
      if (!preview.url.startsWith("/")) return false;
      if (preview.title in signatures) return false;
      return true;
    })
    .map((preview) => preview.title);
}
