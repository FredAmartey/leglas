import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

import type { Annotation } from "./annotations.js";
import { NO_BROWSER, type BrowserPool } from "./browser.js";
import { MAX_WIDTH, MIN_WIDTH, capturePage, type CaptureInput } from "./capture.js";
import type { Preview } from "./config.js";
import type { HydrationEvidence } from "./hydration.js";

/**
 * Images belonging to one change request.
 *
 * Captures are machine-local like the queue itself. Keeping them under the
 * request id gives cleanup one safe directory to remove and gives the prompt
 * stable project-relative paths every agent can read.
 */

export const CAPTURES_DIR = ".leglas/captures";
export const REFERENCES_DIR = ".leglas/references";

/**
 * How much of a deadline a page may spend on its load event.
 *
 * A page with one stalled resource never fires load, and a capture that
 * waited the whole deadline for it would be abandoned with nothing to show,
 * although the page rendered long ago. The rest of the time goes to fonts,
 * a settle and the screenshots themselves.
 */
export const LOAD_SHARE = 0.6;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type AttachmentKind = "frame" | "note" | "compare" | "reference";
export type Attachment = {
  kind: AttachmentKind;
  file: string;
  width: number;
  height: number;
  title?: string;
  note?: string;
  viewport?: number;
};

export type Captured = {
  attachments: Attachment[];
  errors: string[];
  hydration: HydrationEvidence | null;
  cut: boolean;
  skipped: string | null;
};

export type AttachInput = {
  origin: string;
  preview: Preview;
  width: number;
  notes: readonly Annotation[];
  compare: Preview | null;
  references: readonly string[];
};

const requestedWidths = new WeakMap<Captured, number>();

/** The requested viewport retained for prompt prose even when no frame landed. */
export function capturedViewport(captured: Captured): number | null {
  return requestedWidths.get(captured) ?? null;
}

/** Resolve a direction against the Leglas origin without changing absolute URLs. */
export function previewUrl(origin: string, preview: Preview): string {
  if (/^https?:\/\//i.test(preview.url)) return preview.url;
  return new URL(preview.url, origin).href;
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return null;
}

function gifSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return null;
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += length + 2;
  }
  return null;
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return null;
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

/** Identify an attached image from its container bytes, never its claimed type or name. */
export function sniffImage(bytes: Buffer): {
  kind: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
} | null {
  const unknown = { width: 0, height: 0 };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { kind: "png", ...(pngSize(bytes) ?? unknown) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "jpg", ...(jpegSize(bytes) ?? unknown) };
  }
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  ) {
    return { kind: "gif", ...(gifSize(bytes) ?? unknown) };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "webp", ...(webpSize(bytes) ?? unknown) };
  }
  return null;
}

async function moveReference(
  cwd: string,
  id: string,
  destinationDir: string,
  index: number,
): Promise<Attachment | null> {
  let names: string[];
  try {
    names = await readdir(join(cwd, REFERENCES_DIR));
  } catch {
    return null;
  }
  const sourceName = names.find((name) => name.startsWith(`${id}.`));
  if (sourceName === undefined) return null;
  const extension = extname(sourceName).toLowerCase();
  const destinationName = `reference-${index}${extension}`;
  const source = join(cwd, REFERENCES_DIR, sourceName);
  const destination = join(destinationDir, destinationName);
  await mkdir(destinationDir, { recursive: true });
  try {
    await rename(source, destination);
  } catch {
    await copyFile(source, destination);
    await unlink(source).catch(() => {});
  }
  const sniffed = sniffImage(await readFile(destination));
  return {
    kind: "reference",
    file: `${CAPTURES_DIR}/${basename(destinationDir)}/${destinationName}`,
    width: sniffed?.width ?? 0,
    height: sniffed?.height ?? 0,
  };
}

function focusOf(note: Annotation) {
  return {
    selector: note.anchor.selector,
    text: note.anchor.text,
    tag: note.anchor.tag,
    ...(note.anchor.region === undefined ? {} : { region: note.anchor.region }),
    rect: note.anchor.rect,
  };
}

/** Capture everything one request can carry, returning partial work on failure. */
export async function attachRequest(
  cwd: string,
  requestId: string,
  input: AttachInput,
  deps: { pool: BrowserPool; capture?: typeof capturePage; deadlineMs?: number },
): Promise<Captured> {
  const capture = deps.capture ?? capturePage;
  const deadlineMs = deps.deadlineMs ?? 12_000;
  const destination = join(cwd, CAPTURES_DIR, requestId);
  const captured: Captured = {
    attachments: [],
    errors: [],
    hydration: null,
    cut: false,
    skipped: null,
  };
  const references: Attachment[] = [];
  requestedWidths.set(captured, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(input.width))));

  const controller = new AbortController();
  let expired = false;
  let finishDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => {
    finishDeadline = resolve;
  });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    finishDeadline();
  }, deadlineMs);
  timer.unref?.();

  for (let index = 0; index < input.references.length; index += 1) {
    const reference = await moveReference(
      cwd,
      input.references[index] as string,
      destination,
      index + 1,
    ).catch(() => null);
    if (reference !== null) references.push(reference);
  }

  const work = (async () => {
    try {
      const browser = await deps.pool.acquire();
      if (expired) return;
      if (browser === null) {
        captured.skipped = deps.pool.reason() ?? NO_BROWSER;
        return;
      }
      const directionInput: CaptureInput & { signal: AbortSignal } = {
        url: previewUrl(input.origin, input.preview),
        width: input.width,
        focuses: input.notes.map(focusOf),
        timeoutMs: Math.max(1, Math.floor(deadlineMs * LOAD_SHARE)),
        signal: controller.signal,
      };
      const direction = await capture(browser, directionInput);
      if (expired) return;
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "frame.png"), direction.frame.png);
      captured.attachments.push({
        kind: "frame",
        file: `${CAPTURES_DIR}/${requestId}/frame.png`,
        width: direction.frame.width,
        height: direction.frame.height,
        title: input.preview.title,
        viewport: direction.frame.width,
      });
      captured.errors = direction.errors;
      captured.hydration = direction.hydration;
      captured.cut = direction.cut;

      for (let index = 0; index < direction.crops.length; index += 1) {
        const crop = direction.crops[index];
        const note = input.notes[index];
        if (crop === null || crop === undefined || note === undefined || expired) continue;
        const name = `note-${index + 1}.png`;
        await writeFile(join(destination, name), crop.shot.png);
        captured.attachments.push({
          kind: "note",
          file: `${CAPTURES_DIR}/${requestId}/${name}`,
          width: crop.shot.width,
          height: crop.shot.height,
          title: input.preview.title,
          note: note.id,
          viewport: direction.frame.width,
        });
      }

      if (input.compare !== null && !expired) {
        const compareInput: CaptureInput & { signal: AbortSignal } = {
          url: previewUrl(input.origin, input.compare),
          width: input.width,
          timeoutMs: Math.max(1, Math.floor(deadlineMs * LOAD_SHARE)),
          signal: controller.signal,
        };
        const comparison = await capture(browser, compareInput);
        if (expired) return;
        await writeFile(join(destination, "compare.png"), comparison.frame.png);
        captured.attachments.push({
          kind: "compare",
          file: `${CAPTURES_DIR}/${requestId}/compare.png`,
          width: comparison.frame.width,
          height: comparison.frame.height,
          title: input.compare.title,
          viewport: comparison.frame.width,
        });
      }
    } catch (error) {
      if (!expired) {
        captured.skipped = error instanceof Error ? error.message : `The page did not load: ${String(error)}`;
      }
    }
  })();

  await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (expired) captured.skipped = "The design could not be captured in time.";
  captured.attachments.push(...references);
  return captured;
}

/**
 * The directory an id owns, or null for an id that could name anything else.
 *
 * Ids come from the queue file, which is machine-local but editable, and the
 * one thing a removal must never do is follow `..` out of the captures
 * directory. Only the shape Leglas mints gets a path.
 */
function captureDirectory(cwd: string, requestId: string): string | null {
  return /^[A-Za-z0-9_-]{1,32}$/.test(requestId) ? join(cwd, CAPTURES_DIR, requestId) : null;
}

/** Remove the directory belonging to one request, without failing its caller. */
export async function removeCaptures(cwd: string, requestId: string): Promise<void> {
  const directory = captureDirectory(cwd, requestId);
  if (directory === null) return;
  await rm(directory, { recursive: true, force: true });
}

/** Move a failed request's already-captured images under its fresh retry id. */
export async function rehomeCaptures(
  cwd: string,
  from: string,
  to: string,
  attachments: readonly Attachment[],
): Promise<Attachment[]> {
  if (attachments.length === 0) return [];
  const source = captureDirectory(cwd, from);
  const destination = captureDirectory(cwd, to);
  if (source === null || destination === null) return [...attachments];
  await mkdir(join(cwd, CAPTURES_DIR), { recursive: true });
  await rename(source, destination);
  const prefix = `${CAPTURES_DIR}/${from}/`;
  return attachments.map((attachment) => ({
    ...attachment,
    file: attachment.file.startsWith(prefix)
      ? `${CAPTURES_DIR}/${to}/${attachment.file.slice(prefix.length)}`
      : attachment.file,
  }));
}

/** Point every capture path in a prompt at the directory it was moved to. */
export function rehomeText(text: string, from: string, to: string): string {
  return text.split(`${CAPTURES_DIR}/${from}/`).join(`${CAPTURES_DIR}/${to}/`);
}

/**
 * The captures directory, when it is a real directory of ours.
 *
 * Everything that deletes works from here. A symlink in this position would
 * make the boot prune walk somewhere else and remove directories there, so a
 * link is refused rather than followed: Leglas made this directory, and if
 * something else is standing in its place, it is not Leglas's to clear.
 */
async function ownCapturesRoot(cwd: string): Promise<string | null> {
  const root = join(cwd, CAPTURES_DIR);
  try {
    const entry = await lstat(root);
    return entry.isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * Whether a path is a plain file that really lives under this project's
 * captures, links resolved.
 *
 * The lexical check upstream stops `..`; this stops a link inside the
 * directory pointing anywhere else. It matters because the file's bytes are
 * about to be read and sent to a model.
 */
export async function isOwnCapture(cwd: string, file: string): Promise<boolean> {
  const root = await realpath(join(cwd, CAPTURES_DIR)).catch(() => null);
  if (root === null) return false;
  const real = await realpath(resolve(cwd, file)).catch(() => null);
  if (real === null || !real.startsWith(root + sep)) return false;
  return (await stat(real).catch(() => null))?.isFile() === true;
}

/** Drop abandoned request captures and reference uploads that were never sent. */
export async function pruneCaptures(cwd: string, keep: readonly string[]): Promise<void> {
  const kept = new Set([...keep, "show"]);
  const root = await ownCapturesRoot(cwd);
  if (root === null) return void (await pruneReferences(cwd));
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(
      entries
        // isDirectory() on a Dirent is an lstat, so a link is not a
        // directory here and is left alone rather than followed and emptied.
        .filter((entry) => entry.isDirectory() && !kept.has(entry.name))
        .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })),
    );
  } catch {
    // There is no capture directory in a project that has never made one.
  }

  await pruneReferences(cwd);
}

/**
 * Drop uploads that no request ever claimed.
 *
 * An hour is long enough to type the words that go with a picture and short
 * enough that a server left running for days does not keep every image ever
 * pasted and abandoned. Called at boot and after each upload, so the rule
 * applies while the server lives and not only when it starts.
 */
export async function pruneReferences(cwd: string): Promise<void> {
  const references = join(cwd, REFERENCES_DIR);
  try {
    if (!(await lstat(references)).isDirectory()) return;
    const entries = await readdir(references, { withFileTypes: true });
    const old = Date.now() - 60 * 60 * 1000;
    await Promise.all(
      entries.filter((entry) => entry.isFile()).map(async (entry) => {
        const file = join(references, entry.name);
        if ((await stat(file)).mtimeMs < old) await unlink(file).catch(() => {});
      }),
    );
  } catch {
    // No uploaded references need pruning.
  }
}
