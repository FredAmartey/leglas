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
  overlaps,
  placeCard,
  unionOf,
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
  /** Carried so opening the pin hands the card the same address the note has. */
  anchor: Anchor;
  box: Box;
  note: string;
  number: number;
  region: Box | null;
  /** Answered by a change that has been sent and has not settled. */
  sent: boolean;
  stale: boolean;
};

/** Where an anchor points now, and how much of that is a guess. */
type Anchored = { about: Box; box: Box; stale: boolean };

/**
 * The card over the preview, holding the words of one note.
 *
 * One state rather than two, because there is only ever one card and it only
 * does one thing. A note being left now and a note left ten minutes ago
 * differ in where the words end up, not in how they are typed, and giving the
 * second its own card is how you end up with two of everything: two
 * placements, two Escape rules, two ways to lose what was typed.
 */
type Open =
  /**
   * Words about a place, kept nowhere yet.
   *
   * `answered` marks the one way a card gets here without being opened that
   * way: the note it held was swept by the change that answered it while it
   * was being reworded.
   */
  | { kind: "new"; anchor: Anchor; answered?: boolean; field: string; note: string }
  /** A note already on the file, opened to be reworded or dropped. */
  | { kind: "kept"; anchor: Anchor; field: string; id: string; note: string };

/** How far a region's own outline sits from the elements it covers. */
const REGION_PAD = 2;

/** A scan cap, so a drag across a huge document cannot lock the frame. */
const SCAN_CAP = 4000;

/** A local cap keeps the picker quick even inside a very large preview. */
const PICK_SCAN_CAP = 600;

/**
 * How much of a note a pin's own name carries.
 *
 * A note runs to 500 characters and the label is read aloud one word at a
 * time, so the whole thing is a sentence nobody can get to the end of. Enough
 * to tell one pin from another is the job; the words themselves are in the
 * card the pin opens.
 */
const LABEL_CAP = 80;

/** What a pin answers to, for anyone not looking at the colours. */
function label(pin: Pin): string {
  const said =
    pin.note.length > LABEL_CAP ? `${pin.note.slice(0, LABEL_CAP - 1)}…` : pin.note;
  return [
    `Annotation ${pin.number}`,
    said === "" ? null : `: ${said}`,
    pin.sent ? ". Sent with a change." : null,
    pin.stale ? ". Its element has gone." : null,
  ]
    .filter((part) => part !== null)
    .join("");
}

/** The same two facts as a tooltip, for anyone using a pointer. */
function pinTitle(pin: Pin): string | undefined {
  const parts = [
    pin.stale ? "This element has moved or gone since the annotation was left." : null,
    pin.sent ? "Already sent with a change that has not landed yet." : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? undefined : parts.join(" ");
}

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
  onRevise,
  paneScale,
  scaling,
  sent,
  title,
}: {
  notes: readonly Annotation[];
  /** Called when Escape backs out of the mode itself. */
  onExit: () => void;
  onForget: (id: string) => void;
  /** Answers whether the note was kept, because the card waits to hear. */
  onKeep: (anchor: Anchor, note: string) => Promise<boolean>;
  /** Called when an existing note is opened and given different words. */
  onRevise: (id: string, note: string) => Promise<boolean>;
  paneScale: number;
  /**
   * Notes a change has already been sent for, and that change has not
   * settled. Their words are in a prompt an agent is holding, so the pin says
   * so and rewording one is understood to be about the next change.
   */
  sent: ReadonlySet<string>;
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
  const [open, setOpen] = useState<Open | null>(null);
  /**
   * A counter behind every card's `field`, so no two openings share one.
   *
   * A write outlives the card that started it, and what tells its answer
   * which card to apply to is that name. Naming cards after the note they
   * hold looked right and was not: two goes at the same pin, or two drafts in
   * a row, are both "the same card" by that measure, and the first write back
   * would close the second card and take what was being typed into it.
   */
  const opened = useRef(0);
  /**
   * A save in flight and a save refused, each named by the card it belongs to.
   *
   * Not a pair of flags, because a write outlives the card that started it:
   * press Enter, click another pin, and a bare flag would have the first
   * card's answer close the second one and take the sentence being typed into
   * it. Everything here is checked against the card on screen now.
   */
  const [saving, setSaving] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
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
   * Where one anchor points now.
   *
   * Resolved from the selector every time rather than trusted from the file,
   * because the design moves: that is what the annotations are for. A selector
   * that no longer resolves falls back to the rectangle recorded when it was
   * left and says so, which is more honest than hiding it or pointing
   * confidently at the wrong element.
   *
   * Read by the pins and by whatever card is open, so the outline under an
   * open card tracks the page it is drawn on. It used to be a snapshot taken
   * when the card opened, and the wheel still belongs to the preview while a
   * card is up: three lines of scroll left the outline behind on the pixels
   * the element had vacated.
   */
  const anchored = useCallback((at: Geometry, anchor: Anchor): Anchored => {
    let found: Element | null = null;
    try {
      found = at.doc.querySelector(anchor.selector);
    } catch {
      // A selector the browser will not parse is a stale one, not a crash.
    }
    const box = found === null ? boxOf(anchor.rect) : boxOf(found.getBoundingClientRect());
    const spot = anchor.spot ?? { x: 0.5, y: 0.5 };
    const region = anchor.region ? boxFromFractions(box, anchor.region) : null;

    return {
      about: region ?? box,
      box: region ?? {
        height: 0,
        width: 0,
        x: box.x + spot.x * box.width,
        y: box.y + spot.y * box.height,
      },
      stale: found === null,
    };
  }, []);

  /** Where each annotation belongs now, in the order the request will read them. */
  const measure = useCallback((): Pin[] => {
    const at = geometry();
    if (at === null) return [];

    return notes.map((note, index) => {
      const where = anchored(at, note.anchor);
      return {
        anchor: note.anchor,
        box: where.box,
        id: note.id,
        note: note.note,
        number: index + 1,
        region: note.anchor.region ? where.about : null,
        sent: sent.has(note.id),
        stale: where.stale,
      };
    });
  }, [anchored, geometry, notes, sent]);

  const remeasure = useCallback(() => setPins(measure()), [measure]);

  /** Re-read what is under the pointer, after the page has moved beneath it. */
  const repick = useCallback(() => {
    const held = pointer.current;
    const at = geometry();
    if (held === null || at === null || open !== null) return;
    setPicked(elementAt(at, held)?.box ?? null);
  }, [elementAt, geometry, open]);

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
   * Owned here and only here, on the preview's own document as well as the
   * shell's, since the pointer is usually over the preview and that document
   * owns the keystroke. The card's field used to answer Escape too, and two
   * answers to one keystroke skipped a rung: the field closed the card,
   * React flushed that synchronously because a keystroke is a discrete
   * event, this listener was replaced mid-dispatch, and the replacement,
   * reading a state with nothing open, backed out of the mode as well. One
   * Escape, one step.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (open !== null) {
        setOpen(null);
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
  }, [geometry, onExit, open]);

  /**
   * A note that goes while its card is up leaves the words behind.
   *
   * The runner forgets the notes a rewrite answered the moment it lands, and
   * that is the same window this card exists to be used in: the pin said the
   * change was in flight and invited a second thought about it. Closing the
   * card there would throw away a sentence someone was halfway through, and
   * leaving it open would leave a field whose Enter can only fail. So the
   * card stays and becomes what it now is, words about a place with no note
   * on it yet, and says so. The field keeps its identity across the change,
   * which is what keeps the half-typed sentence in it.
   */
  useEffect(() => {
    if (open === null || open.kind !== "kept") return;
    if (notes.some((note) => note.id === open.id)) return;
    setOpen({
      anchor: open.anchor,
      answered: true,
      field: open.field,
      kind: "new",
      note: open.note,
    });
  }, [notes, open]);

  /** Measure the card once it exists, so its placement knows its real height. */
  useEffect(() => {
    const node = cardRef.current;
    if (open === null || node === null) return;
    const height = node.offsetHeight;
    const width = node.offsetWidth;
    setCard((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, [open]);

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
    // Touched, not enclosed. A band swept through a row of cards encloses
    // none of them, and requiring containment described that as an area
    // covering nothing at all. Sweeping through things is the gesture people
    // actually make, so intersecting the sweep is what counts.
    const touched = all.filter((element) => {
      const box = boxOf(element.getBoundingClientRect());
      return box.width > 0 && box.height > 0 && overlaps(region, box);
    });
    // The innermost of those, not the outermost. A box drawn around a row is
    // held by the row, and naming the row says only "the row"; naming the
    // heading and the sentence inside each card says what was being looked
    // at. Anything with a touched descendant is that descendant's container.
    const covered = touched.filter(
      (element) =>
        !touched.some((other) => other !== element && element.contains(other)) &&
        // Something that swallows the whole sweep is what the region sits in,
        // not what it points at. A band drawn across empty space would
        // otherwise name the page container and hand over every word on it as
        // one run-on string.
        !contains(boxOf(element.getBoundingClientRect()), region) &&
        // Scaffolding with no words and no picture of its own tells an agent
        // nothing it can act on.
        (elementText(element.textContent) !== "" ||
          ["a", "button", "canvas", "img", "input", "svg", "video"].includes(
            element.tagName.toLowerCase(),
          )),
    );

    // The nearest thing that holds the whole region, which is what makes the
    // annotation resolvable: the region itself belongs to no element.
    let holder: Element = at.doc.body;
    for (const element of all) {
      const box = boxOf(element.getBoundingClientRect());
      if (!contains(box, region)) continue;
      if (holder.contains(element)) holder = element;
    }

    return {
      // What was caught, not the line drawn to catch it.
      bounds: unionOf(covered.map((element) => boxOf(element.getBoundingClientRect()))) ?? region,
      covers: coversFrom(
        covered.map((element) => ({
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
      const swept = boxBetween(from, to);
      const { bounds, covers, holder } = sweep(at, swept);
      const holderBox = boxOf(holder.getBoundingClientRect());
      setOpen({
        anchor: {
          ...anchorFor(holder, holderBox, at.view.innerWidth, {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          }),
          covers,
          region: fractionsIn(holderBox, bounds),
        },
        field: String((opened.current += 1)),
        kind: "new",
        note: "",
      });
      setRefused(null);
      return;
    }

    const target = elementAt(at, to);
    if (target === null) return;
    setOpen({
      anchor: anchorFor(target.element, target.box, at.view.innerWidth, to),
      field: String((opened.current += 1)),
      kind: "new",
      note: "",
    });
    setRefused(null);
  };

  const chrome = scaling && paneScale > 0 ? 1 / paneScale : 1;
  const at = geometry();
  const bounds = { height: at?.view.innerHeight ?? 0, width: at?.view.innerWidth ?? 0 };
  const width = cardWidth(bounds.width);
  // The card and its outline both hang off wherever the anchor points now,
  // re-read on every render so a preview scrolled under an open card takes
  // the card with it.
  const openAt = open === null || at === null ? null : anchored(at, open.anchor);
  const placed =
    openAt === null
      ? null
      : placeCard({
          anchor: openAt.about,
          bounds,
          card: { height: card.height * chrome, width: width * chrome },
        });

  return (
    <div
      className={`absolute inset-0 z-20 ${open === null ? "cursor-crosshair" : "cursor-default"}`}
      onPointerDown={(event) => {
        if (open !== null) return;
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
        if (open !== null) return;
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
        if (open !== null) return;
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
      {picked !== null && open === null && marquee === null ? (
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
          <button
            // The badge alone sizes this box. The card beside it is hidden
            // until hover but still laid out, and while it was a flex sibling
            // its width dragged the centring transform with it, parking every
            // badge half a card to the left of the thing it marks.
            aria-label={label(pin)}
            className="group/pin absolute size-5 cursor-pointer"
            onClick={(event) => {
              event.stopPropagation();
              setOpen({
                anchor: pin.anchor,
                field: String((opened.current += 1)),
                id: pin.id,
                kind: "kept",
                note: pin.note,
              });
              setRefused(null);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            style={{
              left: pin.box.x,
              top: pin.box.y,
              transform: `translate(-50%, -50%) scale(${chrome})`,
              transformOrigin: "center",
            }}
            type="button"
          >
            {/* A pin reads best small and is aimed at by someone holding a
                trackpad and looking at a design. What it is hit by is larger
                than what it is read as, so a pointer that lands near enough
                still lands. */}
            <span aria-hidden className="absolute -inset-1.5" />
            <span
              // A sent pin keeps its colour and takes a ring. It is still the
              // same note about the same place; what it is not is unread.
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-lg outline-offset-2 group-focus-visible/pin:outline group-focus-visible/pin:outline-2 group-focus-visible/pin:outline-white ${
                pin.stale ? "bg-amber-500" : "bg-[#7C9CFF]"
              } ${pin.sent ? "ring-2 ring-white/80" : ""}`}
              title={pinTitle(pin)}
            >
              {pin.number}
            </span>
            {/* The words, on hover only: at rest the pane is showing a design,
                and a row of open cards over it is the thing in the way. It
                stays untouchable on purpose. Chasing a control across the gap
                between a badge and its label is a fight with a hover state,
                and every action worth taking is one click away in the card. */}
            <span className="pointer-events-none absolute left-full top-1/2 ml-1 w-max max-w-56 -translate-y-1/2 truncate rounded-md border border-white/10 bg-[#171717] px-1.5 py-1 text-left text-[11px] leading-snug text-white opacity-0 shadow-lg transition-opacity group-focus-visible/pin:opacity-100 group-hover/pin:opacity-100">
              {pin.note || "No words"}
            </span>
          </button>
        </div>
      ))}

      {open !== null && openAt !== null && placed !== null ? (
        <>
          {/* What the words are about, held visible while they are read or
              typed. Taken from the box the card was placed against, so a note
              opened again outlines whatever it points at now rather than the
              rectangle it was left on. */}
          <div
            className="pointer-events-none absolute bg-[#7C9CFF]/10 outline outline-2 outline-[#7C9CFF]"
            style={{
              height: openAt.about.height,
              left: openAt.about.x,
              top: openAt.about.y,
              width: openAt.about.width,
            }}
          />
          <form
            className="absolute z-30 rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            // The card closes when the words are somewhere other than this
            // field, and not before. Closing on submit read as saved and was
            // not: a refused write left a toast on screen and a sentence
            // nowhere, with no way back to it.
            onSubmit={(event) => {
              event.preventDefault();
              const card = open.field;
              if (saving === card) return;
              const input = event.currentTarget.elements.namedItem("note");
              const words = input instanceof HTMLInputElement ? input.value.trim() : "";
              setSaving(card);
              setRefused((current) => (current === card ? null : current));
              void (open.kind === "new" ? onKeep(open.anchor, words) : onRevise(open.id, words))
                .then((kept) => {
                  setSaving((current) => (current === card ? null : current));
                  if (kept) setOpen((current) => (current?.field === card ? null : current));
                  else setRefused(card);
                })
                .catch(() => {
                  setSaving((current) => (current === card ? null : current));
                  setRefused(card);
                });
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
              defaultValue={open.note}
              // A refusal is about the last Enter, not the next one. Bound
              // only while one is showing, because otherwise this is a
              // re-render of every pin per keystroke to clear nothing.
              onInput={refused === open.field ? () => setRefused(null) : undefined}
              // Keyed by this opening of the card, so a second pin arrives
              // showing that pin's words rather than the last one's: a
              // defaultValue on a node React is reusing is read once. Which is
              // also why a note answered mid-edit keeps this key: it is still
              // the same opening, and the same node carries the half-typed
              // sentence into the card the note's departure turned this into.
              key={open.field}
              name="note"
              placeholder={
                open.kind === "kept"
                  ? `What is wrong with it?`
                  : open.anchor.region
                    ? `What is wrong with this area?`
                    : `What is wrong with this ${open.anchor.tag}?`
              }
            />
            {open.kind === "kept" ? (
              <>
                {/* Two things the words alone cannot say: that an agent is
                    already holding a copy of them, and that the thing they
                    were left on is not there any more. Both change what a
                    second thought is worth, so both are said before the
                    keys are. */}
                {sent.has(open.id) ? (
                  <p className="px-1 pt-1 text-[10px] leading-snug text-[#B7A57A]">
                    Already sent. New words go with the next change.
                  </p>
                ) : null}
                {openAt.stale ? (
                  <p className="px-1 pt-1 text-[10px] leading-snug text-amber-500/90">
                    Its element has gone. The outline is where it was.
                  </p>
                ) : null}
                {refused === open.field ? (
                  <p className="px-1 pt-1 text-[10px] leading-snug text-[#F87171]">
                    Those words were not saved. Enter tries again.
                  </p>
                ) : null}
                {/* Dropping a note lives here rather than on the badge's own
                    label. A control that only exists while the pointer is
                    over something else is a control you lose by moving. */}
                <div className="flex items-center justify-between gap-3 px-1 pt-1 text-[10px] leading-snug text-[#84848C]">
                  <button
                    className="rounded transition-colors hover:text-[#F87171]"
                    onClick={() => {
                      onForget(open.id);
                      setOpen(null);
                    }}
                    type="button"
                  >
                    Forget it
                  </button>
                  <span>Enter saves · Esc drops</span>
                </div>
              </>
            ) : (
              <>
                {/* The note under this card was answered and swept while it
                    was being reworded. The words in the field are still
                    someone's, so they stay; what changed is where Enter puts
                    them, and that is worth a sentence. */}
                {open.answered ? (
                  <p className="px-1 pt-1 text-[10px] leading-snug text-[#B7A57A]">
                    That change has landed. Enter leaves these words as a new note.
                  </p>
                ) : null}
                {refused === open.field ? (
                  <p className="px-1 pt-1 text-[10px] leading-snug text-[#F87171]">
                    Those words were not saved. Enter tries again.
                  </p>
                ) : null}
                <p className="px-1 pt-1 text-[10px] leading-snug text-[#84848C]">
                  {open.anchor.covers && open.anchor.covers.length > 0
                    ? `${open.anchor.covers.length} ${
                        open.anchor.covers.length === 1 ? "element" : "elements"
                      } · Enter keeps it · Esc drops it`
                    : "Enter keeps it · Esc drops it"}
                </p>
              </>
            )}
          </form>
        </>
      ) : null}
    </div>
  );
}
