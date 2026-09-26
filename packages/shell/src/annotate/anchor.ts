import { isString } from "../json.js";

/**
 * How a note finds its way back to what it was left on. A coordinate breaks as
 * soon as anything moves, which is the tool's whole purpose, and a CSS path
 * breaks when a wrapper is added. So an anchor records four independent facts
 * and the resolver uses whichever survived. The agent resolves it with the
 * source open, which it does well given a name, some text and a rough place.
 *
 * These take the smallest shape a real Element satisfies, so the selector walk
 * tests against a hand-built tree with no browser.
 */

export type ElementLike = {
  tagName: string;
  id?: string | null;
  className?: string | SVGAnimatedString | undefined;
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
   * The clicked point as a fraction of the element's box, so the pin lands in
   * the same place when the element changes size: halfway across a headline
   * stays halfway after it's rewritten.
   */
  spot: { x: number; y: number };
  /**
   * A swept area, as fractions of the element's box. The element is then the
   * nearest one holding the whole region, since the region belongs to none.
   */
  region?: { x: number; y: number; width: number; height: number };
  /** The outermost elements the region covers, for the agent to recognise it. */
  covers?: readonly { tag: string; text: string }[];
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
 * Ids worth anchoring to. React's useId mints ids like `:r7:` and a framework
 * may mint one per render; an id that can't survive a reload truncates the path
 * that would have worked.
 */
function stableId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const id = value.trim();

  return /^[A-Za-z][\w-]*$/.test(id) ? id : null;
}

function classList(value: ElementLike["className"]): string[] {
  if (!isString(value)) return [];

  return value.trim().split(/\s+/).filter(Boolean).slice(0, CLASS_CAP);
}

export function elementText(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();

  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP - 1)}…` : text;
}

/**
 * A CSS path to one element, from the nearest stable id or the body.
 * `nth-of-type`, not `nth-child`: adding a heading above a paragraph shifts
 * child indexes, but it's still the first paragraph.
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
 * Everything worth recording about the element a note was left on. Without a
 * pointer position the note lands in the element's middle, the best guess for a
 * note that didn't come from a click.
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
