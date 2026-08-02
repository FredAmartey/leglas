export const WIDGET_MARGIN = 24;

/**
 * Pointer travel that separates a drag from a tap, in px.
 *
 * The widget is a button first and a draggable second. A hand never holds
 * still: a trackpad press routinely slides five to ten pixels, and treating
 * that as a drag settles the widget into a corner and closes the popover
 * instead of opening it, so the button appears to need pressing twice.
 * Measured against the real thing, taps carried up to 6px of travel.
 *
 * Deliberately looser than the rail's 4px. A rail row is a list item where
 * dragging is a first-class action and a stray reorder is cheap to undo; this
 * is the only way into the tools, so a swallowed press is the worse failure.
 * Ten matches the touch slop iOS and Android settled on for the same reason.
 */
export const DRAG_THRESHOLD = 10;

/** The floating button's diameter in px, matching its h-11 w-11. */
export const WIDGET_SIZE = 44;

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
 * Where the widget's box is pinned so the button sits under the pointer.
 *
 * The popover shares that box and stays mounted while hidden, so pinning the
 * box itself at the pointer left the button a popover's height below it and
 * its width to the right: the thing being dragged was nowhere near the hand,
 * and it settled into a corner nobody aimed at. The popover is taken out of
 * the layout for the duration, which leaves just the button to centre.
 */
export function dragAnchor(point: Point): Point {
  return { x: point.x - WIDGET_SIZE / 2, y: point.y - WIDGET_SIZE / 2 };
}

/** Whether the pointer has travelled far enough to mean a drag. */
export function isDrag(start: Point, current: Point, threshold = DRAG_THRESHOLD): boolean {
  return (
    Math.abs(current.x - start.x) > threshold || Math.abs(current.y - start.y) > threshold
  );
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
