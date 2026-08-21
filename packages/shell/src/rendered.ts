/**
 * Below this, a page has not drawn anything worth comparing.
 *
 * A single-page app serves one near-empty shell for every URL and fills it in
 * the browser. Reading it too early, or reading one that never fills, would
 * make every direction look identical.
 */
const MEANINGFUL_TEXT = 12;

/**
 * What a preview actually drew.
 *
 * The earlier version of this compared what the server sent, which cannot work
 * for a client-rendered app: the server returns the same shell for every URL
 * and the direction is chosen in the browser. Every direction looked identical
 * and the check had to be silenced, which meant it never fired for the apps
 * most likely to need it.
 *
 * Comparing the rendered page fixes that and is the more honest rule anyway.
 * Two previews are the same when they look the same, which is the claim being
 * made on screen.
 *
 * Text, structure, and paint together. Text alone would call two very
 * different layouts of the same copy identical; structure alone would call
 * two different headlines in the same layout identical; and without paint,
 * deliberate colour variants of one direction were flagged as duplicates, which
 * they visibly are not. An accidental duplicate renders identical colours
 * along with identical words, so it stays caught.
 */
export function renderedSignature(
  text: string,
  tags: readonly string[],
  paint: readonly string[] = [],
  visual: readonly string[] = [],
): string | null {
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalised.length < MEANINGFUL_TEXT) return null;
  return `${tags.join(">")} ${normalised} ${paint.join("|")} ${visual.join("|")}`.trimEnd();
}

/** The style values that carry a page's colour, per sampled element. */
export type PaintStyle = { backgroundColor: string; backgroundImage: string; color: string };

/**
 * Elements that render nothing and so cannot be the page surface. Vite puts
 * its module script inside body, so every app it serves has one of these
 * beside the root; counting them as branches would end the descent at the
 * body, whose colour says nothing.
 */
const UNPAINTED = new Set(["LINK", "META", "NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);

const MAX_VISUAL_ELEMENTS = 720;
const EDGE_SAMPLE = 180;

/**
 * Layout and paint properties that materially change what a direction draws.
 * Reading an explicit allow-list keeps the fingerprint bounded and prevents
 * browser-specific bookkeeping from turning equal pages into false negatives.
 */
const VISUAL_PROPERTIES = [
  "display",
  "visibility",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow-x",
  "overflow-y",
  "opacity",
  "transform",
  "transform-origin",
  "perspective",
  "z-index",
  "color",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "outline",
  "filter",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "clip-path",
  "mask-image",
  "mix-blend-mode",
  "isolation",
  "object-fit",
  "object-position",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "justify-content",
  "justify-self",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "aspect-ratio",
  "pointer-events",
  "animation-name",
  "animation-duration",
  "animation-delay",
  "animation-iteration-count",
  "animation-direction",
  "animation-timing-function",
] as const;

const VOLATILE_ANIMATION_PROPERTIES = new Set([
  "bottom",
  "filter",
  "height",
  "left",
  "opacity",
  "right",
  "top",
  "transform",
  "width",
]);

const PSEUDO_PROPERTIES = [
  "content",
  "display",
  "position",
  "inset",
  "width",
  "height",
  "opacity",
  "transform",
  "color",
  "background-color",
  "background-image",
  "border-radius",
  "box-shadow",
  "filter",
  "clip-path",
] as const;

const VECTOR_ATTRIBUTES = [
  "viewBox",
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
] as const;

const IGNORED_TOOLING = [
  "nextjs-portal",
  "vite-error-overlay",
  "#webpack-dev-server-client-overlay",
  "#leglas-hide-dev-overlays",
].join(",");

type VisualStyle = Pick<CSSStyleDeclaration, "getPropertyValue">;
type RectLike = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

/** Half-pixel precision absorbs rasterisation noise without hiding layout. */
export function quantiseCssPixel(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const quantised = Math.round(value * 2) / 2;
  return Object.is(quantised, -0) ? "0" : String(quantised);
}

function shortHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function bounded(value: string, limit = 480): string {
  const normalised = value.replace(/\s+/g, " ").trim();
  if (normalised.length <= limit) return normalised;
  return `${normalised.slice(0, 180)}…${normalised.slice(-80)}#${normalised.length}:${shortHash(normalised)}`;
}

function ignoredTooling(element: Element): boolean {
  return UNPAINTED.has(element.tagName) || element.matches(IGNORED_TOOLING) || element.closest(IGNORED_TOOLING) !== null;
}

function sampleIndices(elements: readonly Element[]): number[] {
  if (elements.length <= MAX_VISUAL_ELEMENTS) return elements.map((_, index) => index);

  const selected = new Set<number>();
  const add = (index: number) => {
    if (index >= 0 && index < elements.length && selected.size < MAX_VISUAL_ELEMENTS) selected.add(index);
  };

  for (let index = 0; index < EDGE_SAMPLE; index += 1) add(index);
  for (let index = Math.max(0, elements.length - EDGE_SAMPLE); index < elements.length; index += 1) add(index);

  // Interactive, media and vector elements carry disproportionate design
  // meaning. Include them and their immediate layout ancestors before filling
  // the remaining budget evenly across a large document.
  for (let index = 0; index < elements.length && selected.size < MAX_VISUAL_ELEMENTS; index += 1) {
    const element = elements[index]!;
    if (!element.matches("a,button,input,select,textarea,summary,[role],svg,svg *,canvas,img,picture,video,audio,iframe")) continue;
    add(index);
    let parent = element.parentElement;
    for (let depth = 0; parent !== null && depth < 3; depth += 1) {
      add(elements.indexOf(parent));
      parent = parent.parentElement;
    }
  }

  const remaining = MAX_VISUAL_ELEMENTS - selected.size;
  if (remaining > 0) {
    const step = (elements.length - 1) / Math.max(1, remaining - 1);
    for (let slot = 0; slot < remaining; slot += 1) add(Math.round(slot * step));
  }

  return [...selected].sort((a, b) => a - b);
}

function elementAnimations(element: Element, style: VisualStyle): boolean {
  if (style.getPropertyValue("animation-name").trim() !== "none") return true;
  const getAnimations = (element as Element & { getAnimations?: () => Animation[] }).getAnimations;
  if (typeof getAnimations !== "function") return false;
  try {
    return getAnimations.call(element).some((animation) => animation.playState === "running");
  } catch {
    return false;
  }
}

function rectSample(element: Element, animated: boolean): string {
  if (animated) return "rect:animated";
  let rect: RectLike;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    return "rect:?";
  }
  const view = element.ownerDocument.defaultView;
  const position = view?.getComputedStyle(element).position;
  const scrollX = position === "fixed" ? 0 : (view?.scrollX ?? 0);
  const scrollY = position === "fixed" ? 0 : (view?.scrollY ?? 0);
  return `rect:${quantiseCssPixel(rect.left + scrollX)},${quantiseCssPixel(rect.top + scrollY)},${quantiseCssPixel(rect.width)},${quantiseCssPixel(rect.height)}`;
}

function attributeSample(element: Element): string {
  const attributes: string[] = [];
  for (const name of VECTOR_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes.push(`${name}:${bounded(value)}`);
  }

  const tag = element.tagName;
  if (["A", "AUDIO", "IFRAME", "IMG", "SOURCE", "VIDEO"].includes(tag)) {
    for (const name of ["href", "src", "srcset", "poster"]) {
      const value = element.getAttribute(name);
      if (value !== null) attributes.push(`${name}:${bounded(value)}`);
    }
  }
  if (tag === "CANVAS") {
    const canvas = element as HTMLCanvasElement;
    attributes.push(`bitmap:${canvas.width}x${canvas.height}`);
  }
  return attributes.join(",");
}

function pseudoSample(
  element: Element,
  pseudo: "::before" | "::after",
  styleOf: (element: Element, pseudo?: string) => VisualStyle,
): string {
  let style: VisualStyle;
  try {
    style = styleOf(element, pseudo);
  } catch {
    return "";
  }
  const content = style.getPropertyValue("content").trim();
  if (content === "" || content === "none" || content === "normal") return "";
  return `${pseudo}{${PSEUDO_PROPERTIES.map((property) => `${property}:${bounded(style.getPropertyValue(property))}`).join(";")}}`;
}

/**
 * A bounded fingerprint of the rendered design at the current viewport.
 *
 * It captures layout, computed visual styles, pseudo-elements, vector paths,
 * media sources and interaction structure. Animation identity is recorded,
 * while the volatile frame of a running animation is not, so two identical
 * previews loaded milliseconds apart still agree.
 */
export function visualSample(
  body: HTMLElement | null,
  styleOf: (element: Element, pseudo?: string) => VisualStyle,
): string[] {
  if (!body) return [];
  const elements = [body, ...body.querySelectorAll("*")].filter((element) => !ignoredTooling(element));
  return sampleIndices(elements).map((index) => {
    const element = elements[index]!;
    const style = styleOf(element);
    const animated = elementAnimations(element, style);
    const styles = VISUAL_PROPERTIES.map((property) => {
      const value = animated && VOLATILE_ANIMATION_PROPERTIES.has(property)
        ? "<animated>"
        : bounded(style.getPropertyValue(property));
      return `${property}:${value}`;
    }).join(";");
    const role = element.getAttribute("role");
    const type = element.getAttribute("type");
    const semantics = [role && `role:${role}`, type && `type:${type}`].filter(Boolean).join(",");
    const before = pseudoSample(element, "::before", styleOf);
    const after = pseudoSample(element, "::after", styleOf);
    return `${element.tagName}${semantics ? `[${semantics}]` : ""}{${rectSample(element, animated)};${styles};${attributeSample(element)};${before};${after}}`;
  });
}

type PaintNode = { children: ArrayLike<unknown>; tagName?: string };

/**
 * The colours a page is painted with, sampled where apps actually put them.
 *
 * The page surface is rarely the body: a React app nests body > root div >
 * page element, and the gradient or background sits on that inner element.
 * Descending while there is exactly one rendered child unwraps those wrappers
 * without ever guessing at app structure, and sampling every level on the way
 * catches the surface wherever it is. Depth is capped so a pathological chain
 * cannot make this expensive.
 */
export function paintSample(
  body: PaintNode | null,
  styleOf: (element: unknown) => PaintStyle,
): string[] {
  if (!body) return [];
  const samples: string[] = [];
  let current: PaintNode = body;
  for (let depth = 0; depth < 4; depth += 1) {
    const style = styleOf(current);
    samples.push(`${style.backgroundColor};${style.backgroundImage};${style.color}`);
    const rendered = Array.from(current.children as ArrayLike<PaintNode>).filter(
      (child) => !UNPAINTED.has(child.tagName ?? ""),
    );
    const only = rendered.length === 1 ? rendered[0] : undefined;
    if (only === undefined) break;
    current = only;
  }
  return samples;
}

/** For each preview, the others that drew the same page. */
export function twinsOf(signatures: Record<string, string | null>): Record<string, string[]> {
  const bySignature = new Map<string, string[]>();
  for (const [title, signature] of Object.entries(signatures)) {
    if (signature === null) continue;
    const group = bySignature.get(signature);
    if (group) group.push(title);
    else bySignature.set(signature, [title]);
  }

  const twins: Record<string, string[]> = {};
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    for (const title of group) {
      twins[title] = group.filter((other) => other !== title);
    }
  }
  return twins;
}
