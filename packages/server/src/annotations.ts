import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Notes left on a spot in a preview, waiting to become a change request.
 *
 * The composer already takes an intent; what it could not take was a place.
 * Most of what gets typed into it is someone describing where a thing is so
 * the agent can find it, which is work the interface is standing right next to
 * and can do exactly. A note carries its own anchor, so the words left over
 * are only ever about what is wrong.
 *
 * Not a comment system. Leglas runs on one machine with no accounts and
 * nobody to reply, so a note that cannot be sent is a note nobody opens twice.
 * These exist to be spent.
 */

/** Where notes wait, beside the queue and the rest of the machine-local state. */
export const ANNOTATIONS_PATH = ".leglas/annotations.json";

export type AnnotationRect = { x: number; y: number; width: number; height: number };

export type AnnotationAnchor = {
  selector: string;
  text: string;
  tag: string;
  classes: readonly string[];
  rect: AnnotationRect;
  /** The point that was pointed at, as a fraction of the element's own box. */
  spot: { x: number; y: number };
  /**
   * A dragged region, as fractions of the element's own box.
   *
   * Present when the annotation was swept across an area rather than aimed at
   * one thing. The element is then the nearest thing that holds the whole
   * region, which is what makes the note resolvable at all: the region itself
   * belongs to no element.
   */
  region?: { x: number; y: number; width: number; height: number };
  /** The outermost elements that region covers, for the agent to recognise it. */
  covers?: readonly { tag: string; text: string }[];
  viewport: number;
};

export type Annotation = {
  id: string;
  /** The direction it was left on, by config title. */
  title: string;
  note: string;
  anchor: AnnotationAnchor;
};

/** Caps for values that arrive from a browser, so one note cannot eat the file. */
const NOTE_CAP = 500;
const SELECTOR_CAP = 300;
const TEXT_CAP = 120;
const TAG_CAP = 40;
const CLASS_CAP = 8;
const CLASS_LENGTH_CAP = 60;
const COVERS_CAP = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, cap: number): string {
  return typeof value === "string" ? value.trim().slice(0, cap) : "";
}

/** A fraction of an element's box, clamped to it, defaulting to its middle. */
function fraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function size(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Read one anchor out of whatever the browser sent.
 *
 * Same posture as the rest of the local API: the request comes from this
 * machine, but the shape is still not this process's to assume. Every field is
 * coerced and capped rather than refused, because a note whose geometry
 * arrived malformed is still a note worth keeping; only a note with nothing to
 * point at is worthless, and that is what a missing selector means.
 */
export function anchorFrom(value: unknown): AnnotationAnchor | null {
  if (!isRecord(value)) return null;
  const selector = text(value["selector"], SELECTOR_CAP);
  if (selector === "") return null;

  const rect = isRecord(value["rect"]) ? value["rect"] : {};
  const classes = Array.isArray(value["classes"])
    ? value["classes"]
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, CLASS_CAP)
        .map((entry) => entry.slice(0, CLASS_LENGTH_CAP))
    : [];

  const rawRegion = isRecord(value["region"]) ? value["region"] : null;
  const region =
    rawRegion === null
      ? null
      : {
          height: fraction(rawRegion["height"]),
          width: fraction(rawRegion["width"]),
          x: fraction(rawRegion["x"]),
          y: fraction(rawRegion["y"]),
        };
  const covers = Array.isArray(value["covers"])
    ? value["covers"]
        .filter(isRecord)
        .slice(0, COVERS_CAP)
        .map((entry) => ({
          tag: text(entry["tag"], TAG_CAP) || "element",
          text: text(entry["text"], TEXT_CAP),
        }))
    : [];

  return {
    classes,
    ...(covers.length === 0 ? {} : { covers }),
    ...(region === null ? {} : { region }),
    rect: {
      height: size(rect["height"]),
      width: size(rect["width"]),
      x: size(rect["x"]),
      y: size(rect["y"]),
    },
    selector,
    spot: {
      x: fraction(isRecord(value["spot"]) ? value["spot"]["x"] : undefined),
      y: fraction(isRecord(value["spot"]) ? value["spot"]["y"] : undefined),
    },
    tag: text(value["tag"], TAG_CAP) || "element",
    text: text(value["text"], TEXT_CAP),
    viewport: size(value["viewport"]),
  };
}

export async function readAnnotations(cwd: string): Promise<Annotation[]> {
  try {
    const raw = await readFile(join(cwd, ANNOTATIONS_PATH), "utf8");
    const parsed = JSON.parse(raw) as { annotations?: unknown };
    if (!Array.isArray(parsed.annotations)) return [];
    return parsed.annotations.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      const anchor = anchorFrom(entry["anchor"]);
      const title = text(entry["title"], TAG_CAP * 4);
      if (anchor === null || title === "") return [];
      return [
        {
          anchor,
          id: typeof entry["id"] === "string" ? entry["id"] : String(index),
          note: text(entry["note"], NOTE_CAP),
          title,
        },
      ];
    });
    // A broken file must never stop the interface from working, the same rule
    // the queue is read under.
  } catch {
    return [];
  }
}

async function write(cwd: string, annotations: readonly Annotation[]): Promise<void> {
  const path = join(cwd, ANNOTATIONS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ annotations }, null, 2)}\n`, "utf8");
}

/**
 * The tail of every change to the notes file, so they happen one at a time.
 *
 * Each of them reads the whole list, changes one entry and writes the whole
 * list back, with the file waiting on either side. Two of those overlapping
 * is one of them undone: the second write was composed from a list the first
 * had already moved on from. It is not a theoretical window either, since the
 * two writers are a person typing and a run finishing, and the run finishing
 * is exactly what makes the note worth retyping.
 *
 * One process is all this has to cover. Leglas serves the interface and hosts
 * the runner from the same one, so the two writers are the two ends of this
 * chain, and a project opened twice at once has a queue file with the same
 * story.
 */
let writing: Promise<unknown> = Promise.resolve();

/** Run one read-change-write after whatever is already in line. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work, work);
  // The chain must survive a failed change; a rejection left on it would
  // take down every note written after it.
  writing = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function addAnnotation(
  cwd: string,
  input: Omit<Annotation, "id">,
): Promise<Annotation> {
  return inTurn(async () => {
    const annotation: Annotation = { ...input, id: randomBytes(6).toString("base64url") };
    await write(cwd, [...(await readAnnotations(cwd)), annotation]);
    return annotation;
  });
}

/**
 * Reword a note that is already there, handing back what it became.
 *
 * Only the words move, and the note keeps its place in the list so the pin
 * keeps the number the interface has been showing. The anchor is the
 * expensive half of a note and the half that was got right by pointing at
 * something, so a second thought about the wording must not cost it.
 *
 * What the words do cost is the note's identity. A change records the ids it
 * answers and freezes its prompt when it is sent, and the runner forgets
 * exactly those ids when it lands. A revision that kept its id would be swept
 * by a change that never carried its words, which is the one outcome the
 * interface promises will not happen. Reissuing every time rather than only
 * when the queue currently names it keeps that promise without asking the
 * queue anything: a change created a moment after this returns would have
 * caught the old id in a lookup and lost the race, and there is no answer
 * about what is in flight that stays true for as long as a write takes.
 *
 * The old id is left to whatever is holding it, pointing at nothing. Sweeping
 * a note that has gone is already how forgetting one works.
 *
 * A note whose id has gone is not an error worth throwing over: null says so,
 * and the same rule as forgetting applies below it, nothing is written.
 */
export async function updateAnnotation(
  cwd: string,
  id: string,
  note: string,
): Promise<Annotation | null> {
  return inTurn(async () => {
    const annotations = await readAnnotations(cwd);
    const found = annotations.find((entry) => entry.id === id);
    if (found === undefined) return null;
    const words = text(note, NOTE_CAP);
    // Opening a note, reading it and pressing Enter is not a second thought.
    // Reissuing it there would quietly take the pin out of the sweep of a
    // change that is about to answer it, and leave it on the pane afterwards
    // as a note about something already done.
    if (words === found.note) return found;
    const revised: Annotation = {
      ...found,
      id: randomBytes(6).toString("base64url"),
      note: words,
    };
    await write(
      cwd,
      annotations.map((entry) => (entry.id === id ? revised : entry)),
    );
    return revised;
  });
}

/** Drop the named notes, reporting how many were there to drop. */
export async function removeAnnotations(
  cwd: string,
  ids: readonly string[],
): Promise<number> {
  return inTurn(async () => {
    const wanted = new Set(ids);
    const annotations = await readAnnotations(cwd);
    const remaining = annotations.filter((entry) => !wanted.has(entry.id));
    const dropped = annotations.length - remaining.length;
    // Same reason an empty queue writes nothing: a request to forget notes
    // that were never there must not materialise .leglas/ in a fresh project.
    if (dropped > 0) await write(cwd, remaining);
    return dropped;
  });
}

/** The notes on one direction, in the order they were left. */
export function annotationsFor(
  annotations: readonly Annotation[],
  title: string,
): Annotation[] {
  return annotations.filter((entry) => entry.title === title);
}

/**
 * One anchor as a line an agent can act on.
 *
 * Ordered by how well each fact survives a change, most durable first. The
 * words an element renders are what an agent can grep for and what a person
 * recognises, so they lead. The geometry is last because it is the first to go
 * stale and is only ever a hint about where to look.
 */
export function describeAnchor(anchor: AnnotationAnchor): string {
  const where =
    `about ${anchor.rect.width}×${anchor.rect.height} at ` +
    `(${anchor.rect.x}, ${anchor.rect.y}) in a ${anchor.viewport}px-wide viewport`;

  // A swept region is not "this element", and saying so would send an agent
  // to rewrite a container when the point was the row of things inside it.
  // What it covers leads, because that is what was being looked at; the
  // element is named as the thing that holds them.
  if (anchor.region !== undefined) {
    const covered = (anchor.covers ?? [])
      .map((entry) => (entry.text === "" ? `<${entry.tag}>` : `<${entry.tag}> “${entry.text}”`))
      .join(", ");
    const inside = covered === "" ? "" : ` covering ${covered};`;
    return `an area inside <${anchor.tag}>;${inside} path ${anchor.selector}; ${where}`;
  }

  const parts = [`<${anchor.tag}>`];
  if (anchor.classes.length > 0) parts.push(`class "${anchor.classes.join(" ")}"`);
  if (anchor.text !== "") parts.push(`reading “${anchor.text}”`);

  return `${parts.join(", ")}; path ${anchor.selector}; ${where}`;
}

/**
 * The notes as the numbered section of a change request.
 *
 * Numbered because the pins in the interface are numbered, and the two have to
 * be the same list read twice: someone checking the agent's work goes back and
 * forth between them. Each note leads with what was asked, because that is the
 * instruction; the anchor follows as the address it applies to.
 */
export function describeAnnotations(annotations: readonly Annotation[]): string {
  return annotations
    .map((annotation, index) => {
      const said = annotation.note === "" ? "Look at this." : annotation.note;
      return `${index + 1}. ${said}\n   The element: ${describeAnchor(annotation.anchor)}`;
    })
    .join("\n\n");
}
