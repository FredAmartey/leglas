/**
 * Images attached to a change request: what the user means, shown rather
 * than described.
 *
 * "Make it feel like this" is the most common design instruction there is,
 * and the composer could not take it. A reference is uploaded the moment it
 * is attached rather than when the request is sent, so sending is only a
 * matter of naming ids, and the strip can be honest about which ones landed
 * before the words are typed.
 *
 * None of this needs a browser to be right: what counts as an image, how
 * many fit, and whether a set is ready to send are all arithmetic over a
 * small shape a real File already satisfies.
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
 * The image files among whatever a clipboard or a drop handed over.
 *
 * Both arrive as a FileList that may hold anything: a pasted screenshot sits
 * beside the text it came with, and a dropped folder brings its neighbours.
 * Only the images are ours.
 */
export function imageFilesFrom<T extends FileLike>(
  files: Iterable<T | null | undefined> | ArrayLike<T | null | undefined>,
): T[] {
  const list = Symbol.iterator in files ? [...(files as Iterable<T | null | undefined>)] : Array.from(files as ArrayLike<T | null | undefined>);
  return list.filter((file): file is T => file != null && isReferenceImage(file));
}

export type Refusal = "too-many" | "too-big" | "not-an-image";

/**
 * Which of the offered files may join the drafts, and why the rest may not.
 *
 * Refusals are reasons rather than a boolean so the toast can say the one
 * thing that would have made the attachment work. The cap counts what is
 * already attached: dropping five onto an empty composer keeps four, and
 * dropping one more onto those four keeps none.
 */
export function admit<T extends FileLike>(
  current: readonly ReferenceDraft[],
  files: readonly T[],
): { accepted: T[]; refused: { file: T; why: Refusal }[] } {
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
 * One sentence for the toast, or nothing when everything was taken.
 *
 * The first reason wins when there are several: the user attached a batch
 * and one message is what they can act on. Counts are said in words the
 * strip already implies, not as numbers of bytes.
 */
export function refusalMessage(refused: readonly { file: FileLike; why: Refusal }[]): string | null {
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
 * The header value that names the file to the server.
 *
 * Header values have to be printable ASCII, and a filename can be anything.
 * The server treats it as decoration and sanitises again on its side; this
 * only has to be something the request can carry.
 */
export function headerName(name: string): string {
  const ascii = displayName(name).replace(/[^\x20-\x7E]/g, "").trim();
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
  return drafts.flatMap((draft) => (draft.status === "ready" && draft.id !== null ? [draft.id] : []));
}

/**
 * Why a set cannot be sent yet, or null when it can.
 *
 * An upload in flight resolves itself in a moment; a failed one needs a
 * decision, because sending without it would quietly drop the thing the user
 * attached on purpose.
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
