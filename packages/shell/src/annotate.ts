/**
 * The geometry behind leaving an annotation: where the card goes, and what a
 * dragged region means.
 *
 * Kept apart from the layer that draws it because none of it needs a browser
 * to be right, and all of it is the kind of arithmetic that is wrong in one
 * corner of one viewport and nowhere else.
 */

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/**
 * How far the pointer travels before a click becomes a region.
 *
 * A press that wanders three pixels is someone clicking on a trackpad, and
 * treating it as a drag would hand them a region they did not ask for. Six is
 * past the wobble and well short of a deliberate sweep.
 */
export const DRAG_THRESHOLD = 6;

export function isDrag(from: Point, to: Point): boolean {
  return Math.abs(to.x - from.x) >= DRAG_THRESHOLD || Math.abs(to.y - from.y) >= DRAG_THRESHOLD;
}

/** The box two corners describe, whichever way round they were dragged. */
export function boxBetween(from: Point, to: Point): Box {
  return {
    height: Math.abs(to.y - from.y),
    width: Math.abs(to.x - from.x),
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
  };
}

export function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * A box expressed as fractions of the box it sits in.
 *
 * The same reasoning as a pin's spot: a region recorded in pixels is a region
 * in the wrong place as soon as its container is a different width, and the
 * container being a different width is what a design change does.
 */
export function fractionsIn(outer: Box, inner: Box): Box {
  const width = outer.width > 0 ? outer.width : 1;
  const height = outer.height > 0 ? outer.height : 1;
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return {
    height: round(inner.height / height),
    width: round(inner.width / width),
    x: round((inner.x - outer.x) / width),
    y: round((inner.y - outer.y) / height),
  };
}

/** The pixels those fractions mean, against whatever the box is now. */
export function boxFromFractions(outer: Box, fractions: Box): Box {
  return {
    height: fractions.height * outer.height,
    width: fractions.width * outer.width,
    x: outer.x + fractions.x * outer.width,
    y: outer.y + fractions.y * outer.height,
  };
}

/**
 * Where the card that takes the words should sit.
 *
 * Below and to the right of what was pointed at, because that is where the
 * eye already is and it leaves the thing being annotated uncovered. Any edge
 * it would cross moves it instead: too low and it flips above the point, too
 * far right and it aligns to the right edge rather than hanging off it. A
 * card taller or wider than the viewport is pinned to the top left, which is
 * the only honest answer when there is no room at all.
 */
export function placeCard(options: {
  /** The element or region the card is about, in the preview's coordinates. */
  anchor: Box;
  card: Size;
  bounds: Size;
  gap?: number;
}): { left: number; top: number; flipped: boolean } {
  const gap = options.gap ?? 8;
  const { anchor, bounds, card } = options;

  // Clear of the thing it is asking about, on whichever side has room. Both
  // edges are used, not one: flipping above the bottom edge would park the
  // card on top of a short element, which is the one thing it must not cover.
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - card.height;
  const flipped = below + card.height > bounds.height && above >= 0;
  const top = flipped ? above : below;

  let left = anchor.x;
  if (left + card.width > bounds.width) left = bounds.width - card.width;

  return {
    flipped,
    left: Math.max(0, left),
    top: Math.max(0, Math.min(top, Math.max(0, bounds.height - card.height))),
  };
}

/**
 * How wide the card should be at this viewport.
 *
 * A 256px card inside a 390px phone preview leaves no margin and covers most
 * of what it is asking about; the same card in a 1440 pane is comfortable.
 * Clamped rather than proportional so it never becomes a slot too narrow to
 * type a sentence into.
 */
export function cardWidth(viewport: number): number {
  if (!Number.isFinite(viewport) || viewport <= 0) return 256;
  return Math.round(Math.min(256, Math.max(180, viewport - 48)));
}

/**
 * The box that holds all of them, or nothing when there are none.
 *
 * A sweep is drawn as a band through things, which is the quickest way to
 * mean "these", but it is a poor description of what was meant: kept as
 * drawn, it records a line through the middle of some text and paints one
 * back over the design. Snapping to what it caught makes the region the
 * thing it named.
 */
export function unionOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { height: bottom - top, width: right - left, x: left, y: top };
}

export type Covered = { tag: string; text: string };

/** Enough for the agent to recognise the region, before the brief bloats. */
const COVERS_CAP = 8;

/**
 * What a region covers, as the request will describe it.
 *
 * The innermost things the sweep touches, not the outermost. A box drawn
 * around a row of cards is held by the row, and naming the row says only
 * "the row"; naming the heading and the sentence inside each card says what
 * was actually being looked at. Anything with a touched descendant is that
 * descendant's container, so it is dropped in favour of it.
 */
export function coversFrom(entries: readonly Covered[]): Covered[] {
  const seen = new Set<string>();
  const kept: Covered[] = [];
  for (const entry of entries) {
    const key = `${entry.tag}:${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
    if (kept.length === COVERS_CAP) break;
  }
  return kept;
}
