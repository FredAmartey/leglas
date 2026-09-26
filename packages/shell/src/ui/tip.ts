/**
 * Keeping a tooltip on screen. Placed from its anchor alone, the floating
 * widget's label went above the viewport in a top corner and past the right
 * edge bottom right, on the control people were unsure about. Corrections are
 * measured after render, since width depends on the text and height on the type
 * scale.
 */

/** Breathing room kept between a tooltip and the edge it would cross, in px. */
export const TIP_MARGIN = 8;

/** Gap between a tooltip and its anchor, in px. */
export const TIP_GAP = 8;

export type Edges = { bottom: number; left: number; right: number; top: number };

export type Placement = "bottom" | "right" | "top";

/**
 * How far to slide a tooltip to clear both sides: a delta to add, so measuring
 * again gives zero. One wider than the viewport pins to the left edge.
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
 * Whether a tooltip above its anchor is cut off and should go below. Only when
 * below is better; in a short viewport both are cut off.
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
 * One correction pass on a freshly measured tooltip: flip below if cut off at
 * the top, else slide clear of the sides. Returns what changed, or null. The
 * shift is computed from the unshifted position each time, so a second pass
 * settles and a label that changes width is refitted for its current text.
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
