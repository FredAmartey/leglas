/**
 * Keeping a tooltip on screen.
 *
 * A tooltip is placed from its anchor alone, which is fine until the anchor is
 * against an edge. The floating widget is the case that exposed it: parked in
 * either top corner its label was drawn above the viewport and cut off, and in
 * the bottom right it ran past the right edge. A label you cannot read is
 * worse than none, because the control it explains is the one you were unsure
 * about.
 *
 * Both corrections are measured after the tooltip renders rather than guessed
 * from a constant, because the width depends on the text and the height on the
 * type scale.
 */

/** Breathing room kept between a tooltip and the edge it would cross, in px. */
export const TIP_MARGIN = 8;

/** Gap between a tooltip and its anchor, in px. */
export const TIP_GAP = 8;

export type Edges = { bottom: number; left: number; right: number; top: number };

export type Placement = "bottom" | "right" | "top";

/**
 * How far to slide a tooltip horizontally so it clears both side edges.
 *
 * Returns a delta to add to the current offset, so applying it and measuring
 * again yields zero. A tooltip wider than the viewport is pinned to the left
 * edge rather than chased off the right.
 */
export function fitShift(rect: Edges, viewportWidth: number, margin = TIP_MARGIN): number {
  if (rect.left < margin) return margin - rect.left;
  if (rect.right > viewportWidth - margin) {
    // Never push the left edge off in the course of pulling the right edge in.
    return Math.max(margin - rect.left, viewportWidth - margin - rect.right);
  }
  return 0;
}

/**
 * Whether a tooltip drawn above its anchor is cut off, and should go below.
 *
 * Only flips when there is somewhere better to go: against a short viewport
 * both placements are cut off, and moving gains nothing.
 */
export function shouldFlipBelow(
  rect: Edges,
  anchor: Edges,
  viewportHeight: number,
  margin = TIP_MARGIN,
): boolean {
  if (rect.top >= margin) return false;
  const height = rect.bottom - rect.top;
  return anchor.bottom + margin + height <= viewportHeight - margin;
}

/**
 * One correction pass over a freshly measured tooltip: flip it below when it
 * is cut off at the top, otherwise slide it clear of the side edges. Returns
 * what changed, or null when the placement already stands.
 *
 * The shift is computed from the unshifted position every time rather than
 * accumulated, so a second pass settles at the same answer and a label that
 * changes width while it is open is refitted for what it says now, not for
 * what it said when the pointer arrived.
 */
export function placeTip(
  tip: { at: Placement; shift: number; x: number; y: number },
  bubble: { height: number; width: number },
  anchor: Edges,
  viewport: { height: number; width: number },
): { at: Placement; shift: number; y: number } | null {
  const left = tip.at === "right" ? tip.x : tip.x - bubble.width / 2;
  const top =
    tip.at === "top"
      ? tip.y - bubble.height
      : tip.at === "bottom"
        ? tip.y
        : tip.y - bubble.height / 2;
  const rect = { bottom: top + bubble.height, left, right: left + bubble.width, top };

  if (tip.at === "top" && shouldFlipBelow(rect, anchor, viewport.height)) {
    return { at: "bottom", shift: tip.shift, y: anchor.bottom + TIP_GAP };
  }
  const shift = fitShift(rect, viewport.width);
  return shift === tip.shift ? null : { at: tip.at, shift, y: tip.y };
}
