import { useCallback, useEffect, useRef, useState } from "react";

import { anchorFor, elementText, type Anchor } from "./anchor.js";
import {
  boxBetween,
  boxFromFractions,
  cardWidth,
  contains,
  coversFrom,
  fractionsIn,
  isDrag,
  placeCard,
  type Box,
  type Point,
} from "./annotate.js";
import type { Annotation } from "./annotations-api.js";

/**
 * The surface that takes annotations, laid over one preview.
 *
 * It lives inside the pane's scaled box, so every position here is in the
 * preview's own coordinates and the outline it draws traces an element at
 * whatever size the pane happens to be showing it. Its own chrome is scaled
 * back the other way, because a card at 40% is a card nobody can read.
 *
 * The preview underneath is a running application, which is why this is a
 * mode: it swallows the pointer so a click lands on the layer instead of the
 * app's own buttons. What it deliberately does not swallow is the wheel,
 * since the thing worth annotating is very often below the fold.
 */

type Geometry = { doc: Document; rect: DOMRect; scale: number; view: Window };

type Pin = {
  id: string;
  box: Box;
  note: string;
  number: number;
  region: Box | null;
  stale: boolean;
};

type Draft = {
  anchor: Anchor;
  /** What the card has to keep clear of, in the preview's own coordinates. */
  about: Box;
};

/** How far a region's own outline sits from the elements it covers. */
const REGION_PAD = 2;

/** A scan cap, so a drag across a huge document cannot lock the frame. */
const SCAN_CAP = 4000;

/** A local cap keeps the picker quick even inside a very large preview. */
const PICK_SCAN_CAP = 600;

function boxOf(rect: DOMRect | Box): Box {
  return "left" in rect
    ? { height: rect.height, width: rect.width, x: rect.left, y: rect.top }
    : rect;
}

function containsPoint(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.y >= box.y &&
    point.x <= box.x + box.width &&
    point.y <= box.y + box.height
  );
}

export function AnnotateLayer({
  notes,
  onExit,
  onForget,
  onKeep,
  paneScale,
  scaling,
  title,
}: {
  notes: readonly Annotation[];
  /** Called when Escape backs out of the mode itself. */
  onExit: () => void;
  onForget: (id: string) => void;
  onKeep: (anchor: Anchor, note: string) => void;
  paneScale: number;
  scaling: boolean;
  title: string;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLFormElement | null>(null);
  /** The last place the pointer was, so scrolling can re-read what is under it. */
  const pointer = useRef<Point | null>(null);
  /** A drag in progress, kept in document coordinates so scrolling cannot move it. */
  const dragging = useRef<{ from: Point; scroll: Point } | null>(null);

  const [picked, setPicked] = useState<Box | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [card, setCard] = useState({ height: 92, width: 256 });

  const geometry = useCallback((): Geometry | null => {
    const frame = document.querySelector<HTMLIFrameElement>(
      `iframe[data-preview="${CSS.escape(title)}"]`,
    );
    if (frame === null) return null;
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      // Another origin. Unreadable by design, so annotations are unavailable.
      return null;
    }
    const view = doc?.defaultView ?? null;
    if (doc === null || view === null) return null;
    const rect = frame.getBoundingClientRect();
    return { doc, rect, scale: view.innerWidth > 0 ? rect.width / view.innerWidth : 1, view };
  }, [title]);

  /** A pointer position in the shell, in the preview's own coordinates. */
  const toPreview = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const at = geometry();
      if (at === null) return null;
      return { x: (clientX - at.rect.left) / at.scale, y: (clientY - at.rect.top) / at.scale };
    },
    [geometry],
  );

  /**
   * The smallest meaningful element under the pointer.
   *
   * A visual detail is often intentionally `pointer-events: none`, especially
   * in motion-heavy designs. Browser hit testing then skips it and returns a
   * large wrapper instead. Start from the actual hit, inspect only its nearby
   * subtree, and rank every visible box that contains the point. That keeps
   * the picker quiet while making text spans, image layers and other fine
   * details directly annotatable.
   */
  const elementAt = useCallback((at: Geometry, point: Point): { box: Box; element: Element } | null => {
    const hit = at.doc.elementFromPoint(point.x, point.y);
    if (hit === null) return null;

    const candidates = new Set<Element>();
    let scope: Element | null = hit;
    let scanned = 0;
    // Looking through the hit element and its two closest containers catches
    // layered siblings without turning every pointer move into a page-wide
    // layout scan.
    for (let depth = 0; scope !== null && depth < 3 && scanned < PICK_SCAN_CAP; depth += 1) {
      candidates.add(scope);
      const walk = at.doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      let descendant = walk.nextNode();
      while (descendant !== null && scanned < PICK_SCAN_CAP) {
        if (!candidates.has(descendant as Element)) {
          candidates.add(descendant as Element);
          scanned += 1;
        }
        descendant = walk.nextNode();
      }
      scope = scope.parentElement;
    }

    const weight = (element: Element) => {
      const tag = element.tagName.toLowerCase();
      const text = elementText(element.textContent);
      return (
        (text === "" ? 0 : 4) +
        (tag === "a" || tag === "button" || tag === "img" ? 3 : 0) +
        (/^h[1-6]$/.test(tag) || tag === "p" || tag === "li" ? 2 : 0)
      );
    };

    const visible = [...candidates]
      .filter((element) => {
        const tag = element.tagName.toLowerCase();
        if (
          element === at.doc.body ||
          element === at.doc.documentElement ||
          tag === "head" ||
          tag === "script" ||
          tag === "style"
        ) {
          return false;
        }
        const box = boxOf(element.getBoundingClientRect());
        if (box.width <= 0 || box.height <= 0 || !containsPoint(box, point)) return false;
        const style = at.view.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        box: boxOf(element.getBoundingClientRect()),
        element,
        weight: weight(element),
      }));

    if (visible.length === 0) return null;

    visible.sort((a, b) => {
      const aContainsB = a.element.contains(b.element);
      const bContainsA = b.element.contains(a.element);
      if (aContainsB !== bContainsA) return aContainsB ? 1 : -1;

      const weightDifference = b.weight - a.weight;
      if (weightDifference !== 0) return weightDifference;

      return a.box.width * a.box.height - b.box.width * b.box.height;
    });

    return visible[0] ?? null;
  }, []);

  /**
   * Where each annotation belongs now.
   *
   * Resolved from the selector every time rather than trusted from the file,
   * because the design moves: that is what the annotations are for. A selector
   * that no longer resolves falls back to the rectangle recorded when it was
   * left and says so, which is more honest than hiding it or pointing
   * confidently at the wrong element.
   */
  const measure = useCallback((): Pin[] => {
    const at = geometry();
    if (at === null) return [];

    return notes.map((note, index) => {
      let found: Element | null = null;
      try {
        found = at.doc.querySelector(note.anchor.selector);
      } catch {
        // A selector the browser will not parse is a stale one, not a crash.
      }
      const box = found === null ? boxOf(note.anchor.rect) : boxOf(found.getBoundingClientRect());
      const spot = note.anchor.spot ?? { x: 0.5, y: 0.5 };
      const region = note.anchor.region ? boxFromFractions(box, note.anchor.region) : null;

      return {
        box: region ?? {
          height: 0,
          width: 0,
          x: box.x + spot.x * box.width,
          y: box.y + spot.y * box.height,
        },
        id: note.id,
        note: note.note,
        number: index + 1,
        region,
        stale: found === null,
      };
    });
  }, [geometry, notes]);

  const remeasure = useCallback(() => setPins(measure()), [measure]);

  /** Re-read what is under the pointer, after the page has moved beneath it. */
  const repick = useCallback(() => {
    const held = pointer.current;
    const at = geometry();
    if (held === null || at === null || draft !== null) return;
    setPicked(elementAt(at, held)?.box ?? null);
  }, [draft, elementAt, geometry]);

  useEffect(() => {
    remeasure();
    const at = geometry();
    const onScroll = () => {
      remeasure();
      repick();
    };
    at?.view.addEventListener("scroll", onScroll, { passive: true });
    at?.view.addEventListener("resize", onScroll);
    window.addEventListener("resize", onScroll);
    return () => {
      at?.view.removeEventListener("scroll", onScroll);
      at?.view.removeEventListener("resize", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [geometry, remeasure, repick]);

  /**
   * The wheel belongs to the page, not to the layer over it.
   *
   * The layer covers the frame to catch clicks, which also means it catches
   * every scroll aimed at the preview, and a mode that pins you to the top of
   * the page is a mode you leave to scroll and re-enter. Forwarded by hand,
   * with a non-passive listener because the browser has to be told not to
   * scroll the shell instead.
   */
  useEffect(() => {
    const node = layerRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      const at = geometry();
      if (at === null) return;
      event.preventDefault();
      at.view.scrollBy({ behavior: "auto", left: event.deltaX, top: event.deltaY });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [geometry]);

  /**
   * Escape backs out one step: the card being typed into, then the mode.
   *
   * Owned here because only this knows whether a card is open, and bound on
   * the preview's own document as well as the shell's, since the pointer is
   * usually over the preview and that document owns the keystroke.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (draft !== null) {
        setDraft(null);
        return;
      }
      onExit();
    };
    const targets: EventTarget[] = [window];
    const at = geometry();
    if (at !== null) targets.push(at.doc);
    for (const target of targets) target.addEventListener("keydown", onKey as EventListener);
    return () => {
      for (const target of targets) target.removeEventListener("keydown", onKey as EventListener);
    };
  }, [draft, geometry, onExit]);

  /** Measure the card once it exists, so its placement knows its real height. */
  useEffect(() => {
    const node = cardRef.current;
    if (draft === null || node === null) return;
    const height = node.offsetHeight;
    const width = node.offsetWidth;
    setCard((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, [draft]);

  /**
   * Everything the region covers, outermost first.
   *
   * Only elements wholly inside the sweep: something the drag merely clipped
   * was not what was being pointed at. Anything already inside something else
   * on the list is dropped, because a card, its heading and the heading's span
   * are one thing said three times.
   */
  const sweep = (at: Geometry, region: Box) => {
    const all = [...at.doc.body.querySelectorAll("*")].slice(0, SCAN_CAP);
    const inside = all.filter((element) => {
      const box = boxOf(element.getBoundingClientRect());
      return box.width > 0 && box.height > 0 && contains(region, box);
    });
    let outermost = inside.filter(
      (element) => !inside.some((other) => other !== element && other.contains(element)),
    );
    // A sweep across three cards catches the grid that holds them, and naming
    // the grid describes the area as one run-on string of everyone's text. If
    // the whole region turned out to be a single container whose children are
    // all inside it too, the children are what was being pointed at.
    while (outermost.length === 1) {
      const only = outermost[0] as Element;
      const children = [...only.children].filter((child) => {
        const box = boxOf(child.getBoundingClientRect());
        return box.width > 0 && box.height > 0 && contains(region, box);
      });
      if (children.length < 2) break;
      outermost = children;
    }

    // The nearest thing that holds the whole region, which is what makes the
    // annotation resolvable: the region itself belongs to no element.
    let holder: Element = at.doc.body;
    for (const element of all) {
      const box = boxOf(element.getBoundingClientRect());
      if (!contains(box, region)) continue;
      if (holder.contains(element)) holder = element;
    }

    return {
      covers: coversFrom(
        outermost.map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: elementText(element.textContent),
        })),
      ),
      holder,
    };
  };

  const finish = (to: Point, from: Point | null) => {
    const at = geometry();
    if (at === null) return;

    // A sweep names an area; a click names the thing under it.
    if (from !== null && isDrag(from, to)) {
      const region = boxBetween(from, to);
      const { covers, holder } = sweep(at, region);
      const holderBox = boxOf(holder.getBoundingClientRect());
      setDraft({
        anchor: {
          ...anchorFor(holder, holderBox, at.view.innerWidth, {
            x: region.x + region.width / 2,
            y: region.y + region.height / 2,
          }),
          covers,
          region: fractionsIn(holderBox, region),
        },
        about: region,
      });
      return;
    }

    const target = elementAt(at, to);
    if (target === null) return;
    setDraft({
      anchor: anchorFor(target.element, target.box, at.view.innerWidth, to),
      about: target.box,
    });
  };

  const chrome = scaling && paneScale > 0 ? 1 / paneScale : 1;
  const at = geometry();
  const bounds = { height: at?.view.innerHeight ?? 0, width: at?.view.innerWidth ?? 0 };
  const width = cardWidth(bounds.width);
  const placed =
    draft === null
      ? null
      : placeCard({
          anchor: draft.about,
          bounds,
          card: { height: card.height * chrome, width: width * chrome },
        });

  return (
    <div
      className={`absolute inset-0 z-20 ${draft === null ? "cursor-crosshair" : "cursor-default"}`}
      onPointerDown={(event) => {
        if (draft !== null) return;
        const point = toPreview(event.clientX, event.clientY);
        const frame = geometry();
        if (point === null || frame === null) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer that has already gone cannot be captured, and a drag
          // that never starts is not worth throwing over.
        }
        dragging.current = {
          from: point,
          scroll: { x: frame.view.scrollX, y: frame.view.scrollY },
        };
      }}
      onPointerLeave={() => {
        pointer.current = null;
        if (dragging.current === null) setPicked(null);
      }}
      onPointerMove={(event) => {
        if (draft !== null) return;
        const point = toPreview(event.clientX, event.clientY);
        const frame = geometry();
        if (point === null || frame === null) return;
        pointer.current = point;

        const held = dragging.current;
        if (held !== null) {
          // The start was recorded against the scroll position it was taken
          // at, so a page scrolled mid-drag keeps the region over the content
          // it was drawn on rather than the pixels it started at.
          const from = {
            x: held.from.x + held.scroll.x - frame.view.scrollX,
            y: held.from.y + held.scroll.y - frame.view.scrollY,
          };
          setMarquee(isDrag(from, point) ? boxBetween(from, point) : null);
          setPicked(null);
          return;
        }

        setPicked(elementAt(frame, point)?.box ?? null);
      }}
      onPointerUp={(event) => {
        const held = dragging.current;
        dragging.current = null;
        setMarquee(null);
        if (draft !== null) return;
        const point = toPreview(event.clientX, event.clientY);
        const frame = geometry();
        if (point === null || frame === null) return;
        const from =
          held === null
            ? null
            : {
                x: held.from.x + held.scroll.x - frame.view.scrollX,
                y: held.from.y + held.scroll.y - frame.view.scrollY,
              };
        setPicked(null);
        finish(point, from);
      }}
      ref={layerRef}
    >
      {picked !== null && draft === null && marquee === null ? (
        <div
          className="pointer-events-none absolute bg-[#7C9CFF]/10 outline outline-2 outline-[#7C9CFF]"
          style={{ height: picked.height, left: picked.x, top: picked.y, width: picked.width }}
        />
      ) : null}

      {marquee !== null ? (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-dashed border-[#7C9CFF] bg-[#7C9CFF]/10"
          style={{ height: marquee.height, left: marquee.x, top: marquee.y, width: marquee.width }}
        />
      ) : null}

      {pins.map((pin) => (
        <div key={pin.id}>
          {pin.region === null ? null : (
            <div
              className={`pointer-events-none absolute rounded-sm border-2 border-dashed ${
                pin.stale ? "border-amber-500/70 bg-amber-500/5" : "border-[#7C9CFF]/70 bg-[#7C9CFF]/5"
              }`}
              style={{
                height: pin.region.height + REGION_PAD * 2,
                left: pin.region.x - REGION_PAD,
                top: pin.region.y - REGION_PAD,
                width: pin.region.width + REGION_PAD * 2,
              }}
            />
          )}
          <div
            className="group/pin absolute flex items-center gap-1"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            style={{
              left: pin.box.x,
              top: pin.box.y,
              transform: `translate(-50%, -50%) scale(${chrome})`,
              transformOrigin: "center",
            }}
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-lg ${
                pin.stale ? "bg-amber-500" : "bg-[#7C9CFF]"
              }`}
              title={
                pin.stale ? "This element has moved or gone since the annotation was left." : undefined
              }
            >
              {pin.number}
            </span>
            {/* The words and the way to drop them, on hover only: at rest the
                pane is showing a design, and a row of open cards over it is
                the thing in the way. */}
            <span className="pointer-events-none flex max-w-56 items-center gap-1 rounded-md border border-white/10 bg-[#171717] px-1.5 py-1 text-[11px] leading-snug text-white opacity-0 shadow-lg transition-opacity group-hover/pin:pointer-events-auto group-hover/pin:opacity-100">
              <span className="min-w-0 flex-1 truncate">{pin.note || "No words"}</span>
              <button
                aria-label="Forget this annotation"
                className="shrink-0 rounded px-1 text-[#84848C] transition-colors hover:text-white"
                onClick={(event) => {
                  event.stopPropagation();
                  onForget(pin.id);
                }}
                type="button"
              >
                ×
              </button>
            </span>
          </div>
        </div>
      ))}

      {draft !== null && placed !== null ? (
        <>
          {/* What the words are about, held visible while they are typed. */}
          <div
            className="pointer-events-none absolute bg-[#7C9CFF]/10 outline outline-2 outline-[#7C9CFF]"
            style={
              draft.anchor.region
                ? {
                    height: draft.anchor.region.height * draft.anchor.rect.height,
                    left: draft.anchor.rect.x + draft.anchor.region.x * draft.anchor.rect.width,
                    top: draft.anchor.rect.y + draft.anchor.region.y * draft.anchor.rect.height,
                    width: draft.anchor.region.width * draft.anchor.rect.width,
                  }
                : {
                    height: draft.anchor.rect.height,
                    left: draft.anchor.rect.x,
                    top: draft.anchor.rect.y,
                    width: draft.anchor.rect.width,
                  }
            }
          />
          <form
            className="absolute z-30 rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              const field = event.currentTarget.elements.namedItem("note");
              onKeep(draft.anchor, field instanceof HTMLInputElement ? field.value.trim() : "");
              setDraft(null);
            }}
            ref={cardRef}
            style={{
              left: placed.left,
              top: placed.top,
              transform: `scale(${chrome})`,
              transformOrigin: placed.flipped ? "bottom left" : "top left",
              width,
            }}
          >
            <input
              autoFocus
              className="w-full rounded border border-[#232328] bg-[#2E2E2E]/40 px-2 py-1 text-xs text-white placeholder:text-[#84848C] focus:border-[#D1D5DB]/40 focus:outline-none"
              name="note"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                }
              }}
              placeholder={
                draft.anchor.region
                  ? `What is wrong with this area?`
                  : `What is wrong with this ${draft.anchor.tag}?`
              }
            />
            <p className="px-1 pt-1 text-[10px] leading-snug text-[#84848C]">
              {draft.anchor.covers && draft.anchor.covers.length > 0
                ? `${draft.anchor.covers.length} ${
                    draft.anchor.covers.length === 1 ? "element" : "elements"
                  } · Enter keeps it · Esc drops it`
                : "Enter keeps it · Esc drops it"}
            </p>
          </form>
        </>
      ) : null}
    </div>
  );
}
