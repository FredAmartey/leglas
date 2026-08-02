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

export type Edges = { bottom: number; left: number; right: number; top: number };

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
