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

  return {
    classes,
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

export async function addAnnotation(
  cwd: string,
  input: Omit<Annotation, "id">,
): Promise<Annotation> {
  const annotation: Annotation = { ...input, id: randomBytes(6).toString("base64url") };
  await write(cwd, [...(await readAnnotations(cwd)), annotation]);
  return annotation;
}

/** Drop the named notes, reporting how many were there to drop. */
export async function removeAnnotations(
  cwd: string,
  ids: readonly string[],
): Promise<number> {
  const wanted = new Set(ids);
  const annotations = await readAnnotations(cwd);
  const remaining = annotations.filter((entry) => !wanted.has(entry.id));
  const dropped = annotations.length - remaining.length;
  // Same reason an empty queue writes nothing: a request to forget notes that
  // were never there must not materialise .leglas/ in a fresh project.
  if (dropped > 0) await write(cwd, remaining);
  return dropped;
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
  const parts = [`<${anchor.tag}>`];
  if (anchor.classes.length > 0) parts.push(`class "${anchor.classes.join(" ")}"`);
  if (anchor.text !== "") parts.push(`reading “${anchor.text}”`);

  const where =
    `about ${anchor.rect.width}×${anchor.rect.height} at ` +
    `(${anchor.rect.x}, ${anchor.rect.y}) in a ${anchor.viewport}px-wide viewport`;

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
