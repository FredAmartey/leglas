/**
 * Images attached to a change request, for "make it feel like this". Uploaded
 * when attached rather than when sent, so sending only names ids and the strip
 * shows which landed before the words are typed. Pure arithmetic over a small
 * shape a real File satisfies.
 */

export const REFERENCE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Four is a mood board; more is a folder the agent will not look through. */
export const REFERENCE_CAP = 4;

/** The server's exact limit, so a refusal here is never a surprise there. */
export const REFERENCE_BYTES_CAP = 10_000_000;

export type ReferenceStatus = "uploading" | "ready" | "failed";

export type ReferenceDraft = {
  /** Local identity, before and regardless of a server id. */
  key: string;
  name: string;
  type: string;
  bytes: number;
  /** An object URL for the thumbnail, revoked when the draft leaves. */
  url: string;
  status: ReferenceStatus;
  /** The server's id once the upload landed. */
  id: string | null;
};

export type FileLike = { name: string; type: string; size: number };

export function isReferenceImage(file: FileLike): boolean {
  return REFERENCE_TYPES.includes(file.type);
}

/**
 * The image files among what a paste or drop handed over; a pasted screenshot
 * comes with its text, a dropped folder with its neighbours.
 */
export function imageFilesFrom<T extends FileLike>(
  files: Iterable<T | null | undefined> | ArrayLike<T | null | undefined>,
): T[] {
  const list = Symbol.iterator in files ? [...files] : Array.from(files);

  return list.filter((file): file is T => file != null && isReferenceImage(file));
}

export type Refusal = "too-many" | "too-big" | "not-an-image";

export type Admission<T> = { accepted: T[]; refused: { file: T; why: Refusal }[] };

/**
 * Which offered files may join the drafts, and why the rest can't. Reasons, not
 * a boolean, so the toast can say what would have worked. The cap counts what's
 * attached: five dropped on an empty composer keep four; one more on those four
 * keeps none.
 */
export function admit<T extends FileLike>(
  current: readonly ReferenceDraft[],
  files: readonly T[],
): Admission<T> {
  const accepted: T[] = [];
  const refused: { file: T; why: Refusal }[] = [];
  let room = Math.max(0, REFERENCE_CAP - current.length);

  for (const file of files) {
    if (!isReferenceImage(file)) {
      refused.push({ file, why: "not-an-image" });
      continue;
    }

    if (file.size > REFERENCE_BYTES_CAP) {
      refused.push({ file, why: "too-big" });
      continue;
    }

    if (room === 0) {
      refused.push({ file, why: "too-many" });
      continue;
    }

    room -= 1;
    accepted.push(file);
  }

  return { accepted, refused };
}

/**
 * One sentence for the toast, or nothing if everything was taken. The first
 * reason wins, since one message is what a batch can act on.
 */
export function refusalMessage(
  refused: readonly { file: FileLike; why: Refusal }[],
): string | null {
  const first = refused[0];

  if (first === undefined) return null;
  const many = refused.length > 1;

  switch (first.why) {
    case "too-many":
      return `Up to ${REFERENCE_CAP} images can ride with a change. ${
        many ? `${refused.length} were` : "One was"
      } left off.`;
    case "too-big":
      return `${many ? "Some images are" : "That image is"} over 10MB, which is more than an agent needs. Left off.`;
    case "not-an-image":
      return many
        ? "Only PNG, JPEG, WebP and GIF images can be attached."
        : `${displayName(first.file.name)} is not an image Leglas can attach. PNG, JPEG, WebP or GIF.`;
  }
}

/** A name worth showing, since a pasted screenshot is called "image.png" by every browser. */
export function displayName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();

  return trimmed === "" ? "image" : trimmed;
}

/**
 * The header value naming the file to the server. Headers must be printable
 * ASCII; the server treats the name as decoration and sanitises it again.
 */
export function headerName(name: string): string {
  const ascii = displayName(name)
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

  return (ascii === "" ? "image" : ascii).slice(0, 80);
}

/** Bytes as the strip says them: whole units, one decimal below ten. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;

  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;

  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The ids a request names: only what actually landed. */
export function referenceIds(drafts: readonly ReferenceDraft[]): string[] {
  return drafts.flatMap((draft) =>
    draft.status === "ready" && draft.id !== null ? [draft.id] : [],
  );
}

/**
 * Why a set can't be sent yet, or null. An upload in flight resolves itself; a
 * failed one needs a decision, or sending would drop an attachment made on
 * purpose.
 */
export function sendBlocker(drafts: readonly ReferenceDraft[]): "uploading" | "failed" | null {
  if (drafts.some((draft) => draft.status === "failed")) return "failed";

  if (drafts.some((draft) => draft.status === "uploading")) return "uploading";

  return null;
}

/** Whether a drag carries files at all, before anything is read from it. */
export function carriesFiles(types: ArrayLike<string> | readonly string[] | undefined): boolean {
  if (types === undefined) return false;

  return Array.from(types).includes("Files");
}
