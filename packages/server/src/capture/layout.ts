import { isJsonRecord, isNumber, isString, type JsonValue } from "../json.js";

/**
 * Text a person would see collide or get cut off on a settled page. A page
 * that renders without errors says nothing of either, and generated
 * directions get both.
 */
export type LayoutFinding =
  | { kind: "overlap"; text: string; other: string }
  | { kind: "cut-off"; text: string; edge: Edge; by: number; within: "page" | "container" };

type Edge = "left" | "right" | "top" | "bottom";

function isEdge(value: string): value is Edge {
  return value === "left" || value === "right" || value === "top" || value === "bottom";
}

/**
 * Runs in the page. Only visible text counts: a box in the DOM under zero
 * opacity, a mask or a clip-path is not something a person sees. Rotated
 * and skewed text is skipped, since its axis-aligned boxes cover more than
 * its letters. Two boxes from one block are leading, not a collision.
 */
export const LAYOUT_PROBE = `(() => {
  const OVERLAP_SHARE = 0.05;
  const OVERLAP_MIN = 1;
  const CUT_MIN = 3;
  const CUT_SHARE = 0.08;
  const LAYERED = 4;
  const TILT = 6;
  // Only a page gone wrong everywhere reaches this. The app's own findings are
  // subtracted after, so a low cap could crowd out a direction's.
  const LIMIT = 100;
  const width = window.innerWidth;
  const states = new Map();
  const inks = new Map();
  const context = document.createElement("canvas").getContext("2d");

  // rgba(r, g, b, a), or a / before the alpha in the newer functions
  // (oklab, oklch, color), which computed colours keep.
  const alpha = (colour) => {
    if (colour === "transparent") return 0;
    const slash = /\\/\\s*([\\d.]+)(%?)\\s*\\)$/.exec(colour || "");
    if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
    const match = /rgba\\(([^)]+)\\)/.exec(colour || "");
    const parts = match ? match[1].split(/[\\s,]+/).filter(Boolean) : [];
    return parts.length > 3 ? parseFloat(parts[3]) : 1;
  };

  // Degrees this element turns its content by, or Infinity for a skew or a
  // 3D transform, whose boxes say nothing useful.
  const angleOf = (a, b, c, d) =>
    Math.abs(a * c + b * d) > 0.01 ? Infinity : (Math.atan2(b, a) * 180) / Math.PI;

  const turnOf = (element, style) => {
    let turn = 0;
    if (style.rotate && style.rotate !== "none") turn += parseFloat(style.rotate) || 0;
    const transform = style.transform;
    if (transform && transform !== "none") {
      if (transform.startsWith("matrix3d")) return Infinity;
      const [a, b, c, d] = transform.slice(7, -1).split(",").map(Number);
      turn += angleOf(a, b, c, d);
    }
    return turn;
  };

  const looping = new Set();
  try {
    for (const animation of document.getAnimations()) {
      const timing = animation.effect && animation.effect.getComputedTiming();
      const target = animation.effect && animation.effect.target;
      if (timing && timing.iterations === Infinity && target) looping.add(target);
    }
  } catch (error) {
    // An engine without getAnimations; nothing is excluded for it.
  }

  const stateOf = (element) => {
    if (states.has(element)) return states.get(element);
    const style = getComputedStyle(element);
    const parent = element.parentElement ? stateOf(element.parentElement) : null;
    const clipsText = /text/.test(style.backgroundClip || "") || /text/.test(style.webkitBackgroundClip || "");
    const state = {
      style,
      opacity: (parent ? parent.opacity : 1) * parseFloat(style.opacity || "1"),
      turn: element instanceof SVGGraphicsElement && element.getCTM
        ? (() => {
            const matrix = element.getCTM();
            return matrix ? angleOf(matrix.a, matrix.b, matrix.c, matrix.d) + (parent ? parent.turnOutsideSvg : 0) : 0;
          })()
        : (parent ? parent.turn : 0) + turnOf(element, style),
      // An <svg>'s own CSS transform is outside every getCTM beneath it.
      turnOutsideSvg: element.namespaceURI === "http://www.w3.org/2000/svg" && element.ownerSVGElement
        ? (parent ? parent.turnOutsideSvg : 0)
        : (parent ? parent.turn : 0) + turnOf(element, style),
      masked:
        (parent ? parent.masked : false) ||
        (style.clipPath && style.clipPath !== "none") ||
        (style.maskImage && style.maskImage !== "none") ||
        (style.webkitMaskImage && style.webkitMaskImage !== "none"),
      truncates:
        (parent ? parent.truncates : false) ||
        style.textOverflow === "ellipsis" ||
        (style.webkitLineClamp && style.webkitLineClamp !== "none"),
      moving: (parent ? parent.moving : false) || looping.has(element),
      paintsText: (parent ? parent.paintsText : false) || clipsText,
    };
    states.set(element, state);
    return state;
  };

  const blockOf = (element) => {
    if (element.namespaceURI === "http://www.w3.org/2000/svg") return element.closest("text") || element;
    for (let node = element; node; node = node.parentElement) {
      const display = stateOf(node).style.display;
      if (display !== "inline" && display !== "contents") return node;
    }
    return document.body;
  };

  const set = (value) => Boolean(value) && value !== "none" && value !== "normal";

  const establishes = (style) =>
    set(style.transform) ||
    set(style.scale) ||
    set(style.rotate) ||
    set(style.translate) ||
    set(style.perspective) ||
    set(style.filter) ||
    set(style.backdropFilter) ||
    set(style.containerType) ||
    style.contentVisibility === "auto" ||
    /transform|perspective|filter|scale|rotate|translate/.test(style.willChange || "") ||
    /paint|layout|strict|content/.test(style.contain || "");

  const clipRect = (element, style) => {
    const match = /rect\\(([^)]+)\\)/.exec(style.clip || "");
    if (!match || (style.position !== "absolute" && style.position !== "fixed")) return null;
    const outer = element.getBoundingClientRect();
    const [top, right, bottom, left] = match[1].split(/[\\s,]+/).filter(Boolean);
    const at = (value, fallback, origin) => (value === "auto" ? fallback : origin + parseFloat(value));
    return {
      left: at(left, outer.left, outer.left),
      right: at(right, outer.right, outer.left),
      top: at(top, outer.top, outer.top),
      bottom: at(bottom, outer.bottom, outer.top),
      page: false,
      cutsX: true,
      cutsY: true,
    };
  };

  // With the root's overflow visible, the body's overflow is the viewport's,
  // which the page clip already is, and the body's own box clips nothing.
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyIsViewport = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";

  // Every box that clips the text: its own element first. A positioned box
  // escapes every clipping box between it and its containing block.
  const clippers = (element) => {
    const found = [{ left: 0, right: width, top: 0, bottom: Infinity, page: true, cutsX: true, cutsY: true }];
    let escaping = null;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = stateOf(node).style;
      if (node !== element) {
        if (escaping === "absolute" && (style.position !== "static" || establishes(style))) escaping = null;
        if (escaping === "fixed" && establishes(style)) escaping = null;
      }
      if (escaping === null) {
        // A scrolling box hides what is scrolled away but cuts nothing off: the
        // rest is a scroll away. The document's own scroller hides nothing.
        const root = node === document.body;
        const hides = (value) => !(root && bodyIsViewport) && (value === "hidden" || value === "clip");
        const scrolls = (value) => !root && (value === "auto" || value === "scroll");
        const x = hides(style.overflowX) || scrolls(style.overflowX);
        const y = hides(style.overflowY) || scrolls(style.overflowY);
        if (x || y) {
          // The client box is measured before transforms, the bounding box after.
          const outer = node.getBoundingClientRect();
          const wide = typeof node.offsetWidth === "number" ? node.offsetWidth : node.clientWidth + 2 * node.clientLeft;
          const tall = typeof node.offsetHeight === "number" ? node.offsetHeight : node.clientHeight + 2 * node.clientTop;
          const across = wide > 0 ? outer.width / wide : 1;
          const down = tall > 0 ? outer.height / tall : 1;
          const left = outer.left + node.clientLeft * across;
          const top = outer.top + node.clientTop * down;
          found.push({
            left: x ? left : -Infinity,
            right: x ? left + node.clientWidth * across : Infinity,
            top: y ? top : -Infinity,
            bottom: y ? top + node.clientHeight * down : Infinity,
            page: false,
            cutsX: hides(style.overflowX),
            cutsY: hides(style.overflowY),
          });
        }
        const clipped = clipRect(node, style);
        if (clipped) found.push(clipped);
      }
      if (style.position === "absolute" || style.position === "fixed") escaping = style.position;
    }
    return found;
  };

  // The box around the letters themselves: a font's line box reaches past its
  // ink, and display type set tight overlaps line to line without touching.
  const inkOf = (words, style) => {
    const shown = style.textTransform === "uppercase" ? words.toUpperCase() : words;
    const font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(" ");
    const key = font + "\\u0000" + style.letterSpacing + "\\u0000" + shown;
    if (inks.has(key)) return inks.get(key);
    let ink = null;
    if (context) {
      context.font = font;
      if ("letterSpacing" in context) context.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      const measured = context.measureText(shown);
      if (typeof measured.fontBoundingBoxAscent === "number") {
        ink = {
          top: Math.max(0, measured.fontBoundingBoxAscent - measured.actualBoundingBoxAscent),
          bottom: Math.max(0, measured.fontBoundingBoxDescent - measured.actualBoundingBoxDescent),
          left: -measured.actualBoundingBoxLeft,
          right: measured.actualBoundingBoxRight,
          height: measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent,
          advance: measured.width,
        };
      }
    }
    inks.set(key, ink);
    return ink;
  };

  const area = (box) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);

  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const words = node.nodeValue.replace(/\\s+/g, " ").trim();
    const element = node.parentElement;
    if (words === "" || !element || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName)) continue;
    const state = stateOf(element);
    // A slight tilt keeps its box close to its letters; more and the box lies.
    const tilt = Math.abs((((state.turn % 360) + 540) % 360) - 180);
    if (state.style.visibility !== "visible" || state.opacity < 0.05 || state.masked || !(tilt <= TILT)) continue;
    if (alpha(state.style.color) < 0.05 && alpha(state.style.webkitTextFillColor) < 0.05 && !state.paintsText) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const ink = inkOf(words, state.style);
    const clips = clippers(element);
    const boxes = [];
    const lines = [...range.getClientRects()].filter((raw) => raw.width >= 2 && raw.height >= 2);
    const rtl = state.style.direction === "rtl";
    for (const raw of lines) {
      // Scaled type (an SVG viewBox, a scale transform) draws at another size
      // than its computed font-size; the box's own height says by how much.
      const scale = ink && ink.height > 0 ? raw.height / ink.height : 1;
      const top = ink ? ink.top * scale : 0;
      const bottom = ink ? ink.bottom * scale : 0;
      const box = raw.height - top - bottom >= 1
        ? { left: raw.left, right: raw.right, top: raw.top + top, bottom: raw.bottom - bottom }
        : { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom };
      // Across, the ink is known only when the whole string is on this one line,
      // and a line can be stretched one way only (scaleX).
      const wide = ink && ink.advance > 0 ? raw.width / ink.advance : scale;
      if (ink && lines.length === 1 && !rtl && (ink.right - ink.left) * wide >= 1) {
        box.left = Math.max(box.left, raw.left + ink.left * wide);
        box.right = Math.min(box.right, raw.left + ink.right * wide);
      }
      const seen = { ...box };
      for (const clip of clips) {
        seen.left = Math.max(seen.left, clip.left);
        seen.right = Math.min(seen.right, clip.right);
        seen.top = Math.max(seen.top, clip.top);
        seen.bottom = Math.min(seen.bottom, clip.bottom);
      }
      const shows = seen.right - seen.left >= 2 && seen.bottom - seen.top >= 2;
      boxes.push({ box, seen, shows, share: area(box) === 0 ? 0 : area(seen) / area(box), clips });
    }
    if (boxes.length === 0) continue;
    const drawn = ink && ink.height > 0 ? lines[0].height / ink.height : 1;
    const size = (parseFloat(state.style.fontSize) || 16) * drawn;
    texts.push({ words: words.slice(0, 80), boxes, block: blockOf(element), state, size });
  }

  const findings = [];
  const seen = new Set();

  // Collisions between what shows of each box, swept by top edge.
  const shown = texts.flatMap((text) =>
    text.boxes.filter((entry) => entry.share >= 0.5).map((entry) => ({ box: entry.seen, text })),
  );
  shown.sort((a, b) => a.box.top - b.box.top);
  for (let i = 0; i < shown.length && findings.length < LIMIT; i += 1) {
    const a = shown[i];
    for (let j = i + 1; j < shown.length && shown[j].box.top < a.box.bottom; j += 1) {
      const b = shown[j];
      if (a.text.block === b.text.block || a.text === b.text) continue;
      if (a.text.state.moving || b.text.state.moving) continue;
      const across = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const down = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (across < OVERLAP_MIN || down < OVERLAP_MIN) continue;
      if ((across * down) / Math.min(area(a.box), area(b.box)) < OVERLAP_SHARE) continue;
      // Words laid over giant display type are a composition, not a collision,
      // and a variable font's width is past what the canvas can measure.
      const larger = Math.max(a.text.size, b.text.size);
      const smaller = Math.min(a.text.size, b.text.size);
      if (larger >= LAYERED * smaller) continue;
      const pair = [a.text.words, b.text.words].sort().join("\\u0000");
      if (seen.has(pair)) continue;
      seen.add(pair);
      findings.push({ kind: "overlap", text: a.text.words, other: b.text.words });
      if (findings.length >= LIMIT) break;
    }
  }

  // Cut off: partly shown. Text hidden whole is a choice (screen reader
  // text, a rolling digit, a carousel), not a mistake.
  for (const text of texts) {
    if (findings.length >= LIMIT) break;
    if (text.state.truncates || text.state.moving) continue;
    let cut = null;
    for (const entry of text.boxes) {
      if (!entry.shows || entry.share > 0.97) continue;
      const { box } = entry;
      // Nearest clip first, the page last. Past a scroll box, a clip further
      // out sees only what the scroll box shows.
      const inner = { ...box };
      for (const clip of [...entry.clips.slice(1), entry.clips[0]]) {
        const sides = [
          ...(clip.cutsX ? [["left", clip.left - inner.left, box.right - box.left], ["right", inner.right - clip.right, box.right - box.left]] : []),
          ...(clip.cutsY ? [["top", clip.top - inner.top, box.bottom - box.top], ["bottom", inner.bottom - clip.bottom, box.bottom - box.top]] : []),
        ];
        for (const [edge, by, extent] of sides) {
          // A box flush with the page's edge cuts where the page does; say the page.
          const deeper = cut === null || by > cut.by || (clip.page && by === cut.by);
          if (by > Math.max(CUT_MIN, extent * CUT_SHARE) && deeper) {
            cut = { edge, by, within: clip.page ? "page" : "container" };
          }
        }
        if (!clip.cutsX) {
          inner.left = Math.max(inner.left, clip.left);
          inner.right = Math.min(inner.right, clip.right);
        }
        if (!clip.cutsY) {
          inner.top = Math.max(inner.top, clip.top);
          inner.bottom = Math.min(inner.bottom, clip.bottom);
        }
      }
    }
    if (cut) findings.push({ kind: "cut-off", text: text.words, edge: cut.edge, by: Math.round(cut.by), within: cut.within });
  }

  return findings;
})()`;

/** The probe's answer, keeping only well-formed findings. */
export function layoutFindings(value: JsonValue | undefined): LayoutFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: LayoutFinding[] = [];

  for (const entry of value) {
    if (!isJsonRecord(entry) || !isString(entry.text)) continue;

    if (entry.kind === "overlap" && isString(entry.other)) {
      findings.push({ kind: "overlap", text: entry.text, other: entry.other });
    } else if (
      entry.kind === "cut-off" &&
      isString(entry.edge) &&
      isEdge(entry.edge) &&
      isNumber(entry.by) &&
      (entry.within === "page" || entry.within === "container")
    ) {
      findings.push({
        kind: "cut-off",
        text: entry.text,
        edge: entry.edge,
        by: entry.by,
        within: entry.within,
      });
    }
  }

  return findings;
}

/** One finding as a sentence an agent can act on and a person can read. */
export function describeFinding(finding: LayoutFinding): string {
  if (finding.kind === "overlap") return `"${finding.text}" runs into "${finding.other}"`;

  const where = finding.within === "page" ? "the page" : "the box around it";

  return `"${finding.text}" is cut off ${finding.by}px past the ${finding.edge} edge of ${where}`;
}
