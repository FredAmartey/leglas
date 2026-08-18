/**
 * How a note finds its way back to the thing it was left on.
 *
 * A pin dropped at a coordinate is worthless the moment anything moves, and
 * moving things is the entire purpose of the tool: the next change restyles
 * the element the note is about. A CSS path alone is not much better, because
 * a direction that gains a wrapper renumbers every sibling below it.
 *
 * So an anchor records four independent facts about one element, and whoever
 * resolves it uses whichever survived. Leglas never has to resolve it
 * correctly; the agent does, with the direction's own source open in front of
 * it, and it is very good at that given a name, some text and a rough place to
 * look. That is the same division of labour as everything else here.
 *
 * The DOM work stays at the edges. These take the smallest structural shape a
 * real Element already satisfies, so the selector walk can be tested against a
 * hand-built tree with no browser in the room.
 */

export type ElementLike = {
  tagName: string;
  id?: string | null;
  className?: unknown;
  textContent?: string | null;
  parentElement: ElementLike | null;
  children: ArrayLike<ElementLike>;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type Anchor = {
  /** A path from the nearest usable id, or from the document root. */
  selector: string;
  /** The element's own words, trimmed and capped. Empty when it has none. */
  text: string;
  tag: string;
  classes: readonly string[];
  /** Where it sat when the note was left, in the preview's own coordinates. */
  rect: Rect;
  /**
   * The point that was clicked, as a fraction of the element's own box.
   *
   * Stored as a fraction rather than a coordinate so the pin can be put back
   * where it was meant when the element is a different size next time: half
   * way across a headline stays half way across it after the headline is
   * rewritten. A pin parked at the element's top edge instead would sit on
   * whatever is above it, and on a large section it would be nowhere near
   * the thing that was pointed at.
   */
  spot: { x: number; y: number };
  /** The viewport width it was placed at, since layout is width-dependent. */
  viewport: number;
};

/** Long enough to identify a heading or a button, short enough to read. */
const TEXT_CAP = 80;

/** Enough to grep for, before a utility-class soup drowns the description. */
const CLASS_CAP = 6;

/** A path longer than this describes the page's skeleton, not the element. */
const DEPTH_CAP = 8;

/**
 * Ids worth anchoring to.
 *
 * React hands out ids like `:r7:` from useId, and a framework may mint one
 * per render. An id that cannot survive a reload is worse than no id, because
 * it truncates the path that would have worked.
 */
function stableId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z][\w-]*$/.test(id) ? id : null;
}

function classList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.trim().split(/\s+/).filter(Boolean).slice(0, CLASS_CAP);
}

export function elementText(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP - 1)}…` : text;
}

/**
 * A CSS path to one element, from the nearest stable id or the body.
 *
 * `nth-of-type` rather than `nth-child` on purpose: a direction that adds a
 * heading above a paragraph shifts every child index after it, while the
 * paragraph is still the first paragraph. It is the numbering most likely to
 * survive the kind of edit this tool exists to make.
 */
export function selectorFor(element: ElementLike): string {
  const parts: string[] = [];
  let current: ElementLike | null = element;

  while (current !== null && parts.length < DEPTH_CAP) {
    const tag = current.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;

    const id = stableId(current.id);
    if (id !== null) {
      parts.unshift(`#${id}`);
      return parts.join(" > ");
    }

    const parent: ElementLike | null = current.parentElement;
    if (parent === null) {
      parts.unshift(tag);
      break;
    }

    let index = 1;
    for (let at = 0; at < parent.children.length; at += 1) {
      const sibling = parent.children[at];
      if (sibling === current) break;
      if (sibling?.tagName === current.tagName) index += 1;
    }

    parts.unshift(`${tag}:nth-of-type(${index})`);
    current = parent;
  }

  return parts.join(" > ");
}

/** Keep a fraction inside its box, whatever the pointer reported. */
function fraction(value: number, size: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(size) || size <= 0) return 0.5;
  return Math.round(Math.min(1, Math.max(0, value / size)) * 1000) / 1000;
}

/**
 * Everything worth recording about the element a note was left on.
 *
 * The point is where the pointer was, in the same coordinates as the rect.
 * Without one the note lands in the middle of the element, which is the best
 * guess available when a note arrives from somewhere other than a click.
 */
export function anchorFor(
  element: ElementLike,
  rect: Rect,
  viewport: number,
  point?: { x: number; y: number },
): Anchor {
  return {
    classes: classList(element.className),
    rect: {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    },
    selector: selectorFor(element),
    spot: {
      x: point === undefined ? 0.5 : fraction(point.x - rect.x, rect.width),
      y: point === undefined ? 0.5 : fraction(point.y - rect.y, rect.height),
    },
    tag: element.tagName.toLowerCase(),
    text: elementText(element.textContent),
    viewport: Math.round(viewport),
  };
}
