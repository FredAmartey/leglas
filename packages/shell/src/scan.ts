import type { Preview } from "./types.js";

export type PreviewScan =
  | { url: string; status: "complete"; signature: string | null }
  | { url: string; status: "failed" };

export type PreviewScans = Readonly<Record<string, PreviewScan>>;
export type PreviewScanOutcome =
  | { status: "complete"; signature: string | null }
  | { status: "failed" };

function currentScan(preview: Preview, scans: PreviewScans): PreviewScan | null {
  const scan = scans[preview.title];
  return scan?.url === preview.url ? scan : null;
}

/** Remove stale verdicts before a document is replaced or edited. */
export function forgetScans(
  scans: PreviewScans,
  titles: Iterable<string>,
): Record<string, PreviewScan> {
  let next: Record<string, PreviewScan> | null = null;
  for (const title of titles) {
    if (!(title in scans)) continue;
    next ??= { ...scans };
    delete next[title];
  }
  return next ?? scans;
}

/**
 * Mounted panes whose document was replaced in place.
 *
 * A pane reloaded by hand, retried after a failure, or handed a new URL under
 * the same title has a new document, and its verdict has to be read again. A
 * title that merely came on stage has not: the background read already
 * measured that document, and reading it again off stage doubled the cost of
 * every flip.
 */
export function replacedPanes(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const replaced: string[] = [];
  for (const [title, identity] of current) {
    const before = previous.get(title);
    if (before !== undefined && before !== identity) replaced.push(title);
  }
  return replaced;
}

/** Record one scan only against the URL whose document produced it. */
export function recordScan(
  scans: PreviewScans,
  preview: Preview,
  outcome: PreviewScanOutcome,
): Record<string, PreviewScan> {
  const record: PreviewScan =
    outcome.status === "complete"
      ? { url: preview.url, status: "complete", signature: outcome.signature }
      : { url: preview.url, status: "failed" };
  const current = scans[preview.title];
  const sameOutcome =
    (current?.status === "failed" && record.status === "failed") ||
    (current?.status === "complete" &&
      record.status === "complete" &&
      current.signature === record.signature);
  if (
    current?.url === record.url &&
    sameOutcome
  ) {
    return scans;
  }
  return { ...scans, [preview.title]: record };
}

/** Complete duplicate signatures for the current title and URL pairs only. */
export function scanSignatures(
  previews: readonly Preview[],
  scans: PreviewScans,
): Record<string, string | null> {
  const signatures: Record<string, string | null> = {};
  for (const preview of previews) {
    const scan = currentScan(preview, scans);
    if (scan?.status === "complete") signatures[preview.title] = scan.signature;
  }
  return signatures;
}

/**
 * Which previews still need a background read for the duplicate check.
 *
 * Only previews this page can read qualify. A result belongs to one exact URL,
 * so replacing a direction in place queues its new document even when the
 * title stays the same. Failed reads stop retrying for this page load without
 * pretending they produced a comparable signature.
 */
export function scanQueue(
  previews: readonly Preview[],
  scans: PreviewScans,
): Preview[] {
  return previews.filter((preview) => {
    // A branch preview that has not started has no url to read yet.
    if (!preview.url?.startsWith("/")) return false;
    return currentScan(preview, scans) === null;
  });
}
