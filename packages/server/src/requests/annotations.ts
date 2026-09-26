import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isNumber, isString, isJsonRecord, type JsonValue, parseJson } from "../json.js";

/**
 * Notes left on a spot in a preview, waiting to become a change request. A note
 * carries its own anchor, so its words only say what's wrong. Not a comment
 * system: one machine, no accounts, nobody to reply. Notes exist to be sent.
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
   * A dragged region as fractions of the element's box. The element is then the
   * nearest one holding the whole region, since the region belongs to no
   * element.
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

function text(value: JsonValue | undefined, cap: number): string {
  return isString(value) ? value.trim().slice(0, cap) : "";
}

/** A fraction of an element's box, clamped to it, defaulting to its middle. */
function fraction(value: JsonValue | undefined): number {
  if (!isNumber(value) || !Number.isFinite(value)) return 0.5;

  return Math.min(1, Math.max(0, value));
}

function size(value: JsonValue | undefined): number {
  return isNumber(value) && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Reads one anchor from whatever the browser sent. Every field is coerced and
 * capped rather than refused, since a note with malformed geometry is still
 * worth keeping; only a missing selector makes it worthless.
 */
export function anchorFrom(value: JsonValue | undefined): AnnotationAnchor | null {
  if (!isJsonRecord(value)) return null;
  const selector = text(value["selector"], SELECTOR_CAP);

  if (selector === "") return null;

  const rect = isJsonRecord(value["rect"]) ? value["rect"] : {};

  const classes = Array.isArray(value["classes"])
    ? value["classes"]
        .filter((entry): entry is string => isString(entry))
        .slice(0, CLASS_CAP)
        .map((entry) => entry.slice(0, CLASS_LENGTH_CAP))
    : [];

  const rawRegion = isJsonRecord(value["region"]) ? value["region"] : null;

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
        .filter(isJsonRecord)
        .slice(0, COVERS_CAP)
        .map((entry) => ({
          tag: text(entry["tag"], TAG_CAP) || "element",
          text: text(entry["text"], TEXT_CAP),
        }))
    : [];

  const anchor: AnnotationAnchor = {
    classes,
    rect: {
      height: size(rect["height"]),
      width: size(rect["width"]),
      x: size(rect["x"]),
      y: size(rect["y"]),
    },
    selector,
    spot: {
      x: fraction(isJsonRecord(value["spot"]) ? value["spot"]["x"] : undefined),
      y: fraction(isJsonRecord(value["spot"]) ? value["spot"]["y"] : undefined),
    },
    tag: text(value["tag"], TAG_CAP) || "element",
    text: text(value["text"], TEXT_CAP),
    viewport: size(value["viewport"]),
  };

  if (covers.length > 0) anchor.covers = covers;

  if (region !== null) anchor.region = region;

  return anchor;
}

export async function readAnnotations(cwd: string): Promise<Annotation[]> {
  try {
    const raw = await readFile(join(cwd, ANNOTATIONS_PATH), "utf8");
    const parsed = parseJson(raw);

    if (!isJsonRecord(parsed) || !Array.isArray(parsed.annotations)) return [];

    return parsed.annotations.flatMap((entry, index) => {
      if (!isJsonRecord(entry)) return [];
      const anchor = anchorFrom(entry["anchor"]);
      const title = text(entry["title"], TAG_CAP * 4);

      if (anchor === null || title === "") return [];

      return [
        {
          anchor,
          id: isString(entry["id"]) ? entry["id"] : String(index),
          note: text(entry["note"], NOTE_CAP),
          title,
        },
      ];
    });
    // A broken file must never stop the interface, same rule as the queue.
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
 * The tail of every change to the notes file, so they run one at a time. Each
 * reads the whole list, changes an entry and writes it back around awaits, so
 * two overlapping lose one edit. The two writers are a person typing and a run
 * finishing, both in this process. Two Leglas processes on one project still
 * race, as the queue does.
 */
let writing: Promise<unknown> = Promise.resolve();

/** Run one read-change-write after whatever is already in line. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work, work);
  // The chain must survive a failed change, or a rejection would take down
  // every later note.
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
 * Rewords an existing note and returns what it became. The note keeps its
 * place, so its pin keeps its number, and its anchor, the expensive half.
 *
 * The words do cost its id. A change records the ids it answers and freezes its
 * prompt when sent, and the runner forgets those ids when it lands, so a
 * revision keeping its id would be swept by a change that never carried its
 * words. Reissuing every time needs no look at the queue, whose answer could go
 * stale during the write anyway. The old id points at nothing, which is already
 * how forgetting works.
 *
 * A missing id returns null and writes nothing.
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

    // Opening a note and pressing Enter isn't a second thought. Reissuing it
    // would pull the pin out of a change about to answer it and leave it behind
    // as a note about finished work.
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
export async function removeAnnotations(cwd: string, ids: readonly string[]): Promise<number> {
  return inTurn(async () => {
    const wanted = new Set(ids);
    const annotations = await readAnnotations(cwd);
    const remaining = annotations.filter((entry) => !wanted.has(entry.id));
    const dropped = annotations.length - remaining.length;

    // Like an empty queue: forgetting notes that were never there must not
    // create .leglas/ in a fresh project.
    if (dropped > 0) await write(cwd, remaining);

    return dropped;
  });
}

/** The notes on one direction, in the order they were left. */
export function annotationsFor(annotations: readonly Annotation[], title: string): Annotation[] {
  return annotations.filter((entry) => entry.title === title);
}

/**
 * One anchor as a line an agent can act on, most durable fact first. The
 * element's words lead, since an agent can grep them and a person recognises
 * them; geometry is last, since it goes stale first.
 */
export function describeAnchor(anchor: AnnotationAnchor): string {
  const where =
    `about ${anchor.rect.width}×${anchor.rect.height} at ` +
    `(${anchor.rect.x}, ${anchor.rect.y}) in a ${anchor.viewport}px-wide viewport`;

  // A swept region isn't "this element"; saying so would send an agent to
  // rewrite a container instead of the row inside it. What it covers leads, and
  // the element is named as what holds them.
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
 * The notes as the numbered section of a change request. Numbered like the
 * interface's pins, since someone checking the agent's work reads both. Each
 * note leads with what was asked, then its address.
 */
export function describeAnnotations(annotations: readonly Annotation[]): string {
  return annotations
    .map((annotation, index) => {
      const said = annotation.note === "" ? "Look at this." : annotation.note;

      return `${index + 1}. ${said}\n   The element: ${describeAnchor(annotation.anchor)}`;
    })
    .join("\n\n");
}
