export const WIDGET_MARGIN = 24;

export type Point = { x: number; y: number };
export type Stage = { width: number; height: number };
export type Corner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

/**
 * Keep the widget reachable.
 *
 * It is the only way into the tools, so a drag that throws it past an edge, or
 * a window resized smaller afterwards, must not put it out of reach.
 */
export function clampWidget(point: Point, stage: Stage): Point {
  // On a stage narrower than twice the margin the bounds would invert, so
  // collapse to the middle rather than returning a negative range.
  const clamp = (value: number, extent: number) => {
    const low = Math.min(WIDGET_MARGIN, extent / 2);
    const high = Math.max(low, extent - WIDGET_MARGIN);
    return Math.max(low, Math.min(high, value));
  };
  return { x: clamp(point.x, stage.width), y: clamp(point.y, stage.height) };
}

/**
 * The corner a released widget settles into.
 *
 * Free positioning would let it sit anywhere, including over the middle of a
 * design being judged. Corners keep it out of the way and make its position
 * predictable between sessions. Dead centre resolves to bottom right, which is
 * where it starts.
 */
export function nearestCorner(point: Point, stage: Stage): { corner: Corner } {
  const left = point.x < stage.width / 2;
  const top = point.y < stage.height / 2;
  if (top && left) return { corner: "top-left" };
  if (top) return { corner: "top-right" };
  if (left) return { corner: "bottom-left" };
  return { corner: "bottom-right" };
}
