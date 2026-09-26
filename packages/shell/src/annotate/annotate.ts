/**
 * The geometry of leaving an annotation: where the card goes and what a dragged
 * region means. Kept apart from the layer because none of it needs a browser,
 * and it's the kind of arithmetic that goes wrong in one corner of one
 * viewport.
 */

export type Box = { x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

export type Size = { width: number; height: number };

/**
 * How far the pointer travels before a click becomes a region: past a
 * three-pixel trackpad wobble, well short of a deliberate sweep.
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
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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
 * A box as fractions of the box it sits in, so it survives the container
 * changing width, which is what a design change does.
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
 * Where the card should sit: below and right of the target, where the eye
 * already is, leaving the target uncovered. An edge it would cross moves it:
 * too low flips it above, too far right aligns it to the right edge. A card
 * bigger than the viewport is pinned top left.
 */
export type CardPlacement = { left: number; top: number; flipped: boolean };

export function placeCard(options: {
  /** The element or region the card is about, in the preview's coordinates. */
  anchor: Box;
  card: Size;
  bounds: Size;
  gap?: number;
}): CardPlacement {
  const gap = options.gap ?? 8;
  const { anchor, bounds, card } = options;

  // Clear of the target on whichever side has room. Below is measured from the
  // element's bottom and above from its top; flipping from the bottom edge
  // would cover a short element.
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
 * Card width at this viewport. A 256px card in a 390px phone preview covers
 * most of its target; clamped so it never gets too narrow to type in.
 */
export function cardWidth(viewport: number): number {
  if (!Number.isFinite(viewport) || viewport <= 0) return 256;

  return Math.round(Math.min(256, Math.max(180, viewport - 48)));
}

/**
 * The box holding them all, or nothing if there are none. A sweep is drawn as a
 * band through things; kept as drawn it records a line through some text, so it
 * snaps to what it caught.
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
 * What a region covers, as the request describes it: the innermost touched
 * things, since naming the row a box sits in says only "the row". Anything with
 * a touched descendant is dropped for it.
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
