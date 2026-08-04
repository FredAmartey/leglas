import type { Preview } from "./types.js";

/**
 * Which previews still need a background read for the duplicate check.
 *
 * Signatures used to come only from panes the user had opened, so the "Same
 * as" tag trickled in one click at a time and the warning arrived after the
 * judgment it was meant to protect. Unopened previews are read off stage
 * instead, one at a time, so the verdict is complete shortly after load.
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
  mounted: readonly string[],
): string[] {
  const onStage = new Set(mounted);
  return previews
    .filter((preview) => {
      if (!preview.url.startsWith("/")) return false;
      if (preview.title in signatures) return false;
      // The stage will produce its own reading once the pane paints, and a
      // second copy of an app the user is looking at is the more expensive
      // place to duplicate work.
      if (onStage.has(preview.title)) return false;
      return true;
    })
    .map((preview) => preview.title);
}
