import { describe, expect, test } from "vitest";

import {
  forgetScans,
  recordScan,
  replacedPanes,
  scanQueue,
  scanSignatures,
  type PreviewScans,
} from "./scan.js";

const PREVIEWS = [
  { title: "Current", url: "/", tags: [] },
  { title: "Aurora", url: "/?v-hero=aurora", tags: [] },
  { title: "Staging", url: "https://staging.example.com", tags: [] },
  { title: "Paper", url: "/leglas/files/paper/paper.html", tags: [] },
] as const;

describe("scanQueue", () => {
  test("queues same-origin previews without current results", () => {
    expect(scanQueue(PREVIEWS, {}).map((preview) => preview.title)).toEqual([
      "Current",
      "Aurora",
      "Paper",
    ]);
  });

  test("skips cross-origin previews, whose documents are sealed", () => {
    expect(scanQueue(PREVIEWS, {}).map((preview) => preview.title)).not.toContain("Staging");
  });

  test("treats complete and failed reads as terminal for their exact URL", () => {
    const scans: PreviewScans = {
      Current: { url: "/", status: "complete", signature: "sig" },
      Aurora: { url: "/?v-hero=aurora", status: "failed" },
      Paper: { url: "/leglas/files/paper/paper.html", status: "complete", signature: null },
    };

    expect(scanQueue(PREVIEWS, scans)).toEqual([]);
  });

  test("requeues a title when its URL changes", () => {
    const changed = PREVIEWS.map((preview) =>
      preview.title === "Aurora" ? { ...preview, url: "/?v-hero=changed" } : preview,
    );
    const scans: PreviewScans = {
      Current: { url: "/", status: "complete", signature: "current" },
      Aurora: { url: "/?v-hero=aurora", status: "complete", signature: "old" },
      Paper: { url: "/leglas/files/paper/paper.html", status: "complete", signature: "paper" },
    };

    expect(scanQueue(changed, scans).map((preview) => preview.title)).toEqual(["Aurora"]);
    expect(scanSignatures(changed, scans)).toEqual({ Current: "current", Paper: "paper" });
  });

  test("previews that appear mid-session join the queue", () => {
    const grown = [...PREVIEWS, { title: "New", url: "/?v-hero=new", tags: [] }];
    const scans = PREVIEWS.reduce<Record<string, { url: string; status: "complete"; signature: string }>>(
      (current, preview) =>
        preview.url.startsWith("/")
          ? { ...current, [preview.title]: { url: preview.url, status: "complete", signature: "sig" } }
          : current,
      {},
    );

    expect(scanQueue(grown, scans).map((preview) => preview.title)).toEqual(["New"]);
  });
});

describe("scan records", () => {
  test("keeps failures separate from valid empty signatures", () => {
    const failed = recordScan({}, PREVIEWS[0], { status: "failed" });
    const empty = recordScan(failed, PREVIEWS[1], { status: "complete", signature: null });

    expect(scanSignatures(PREVIEWS, empty)).toEqual({ Aurora: null });
    expect(empty.Current).toEqual({ url: "/", status: "failed" });
  });

  test("forgets only the directions whose documents are changing", () => {
    const scans: PreviewScans = {
      Current: { url: "/", status: "complete", signature: "current" },
      Aurora: { url: "/?v-hero=aurora", status: "complete", signature: "aurora" },
    };

    expect(forgetScans(scans, ["Aurora"])).toEqual({
      Current: { url: "/", status: "complete", signature: "current" },
    });
    expect(forgetScans(scans, ["Missing"])).toBe(scans);
  });
});

describe("replacedPanes", () => {
  const identity = (title: string, generation: number) => `${title} /${title} ${generation}`;

  test("a direction coming on stage keeps its verdict", () => {
    // Flipping to a direction loads the same document the background read
    // already measured. Rescanning it off stage doubled the cost of every flip.
    const previous = new Map([["Wave", identity("Wave", 0)]]);
    const current = new Map([["Dot grid", identity("Dot grid", 0)]]);

    expect(replacedPanes(previous, current)).toEqual([]);
  });

  test("a pane reloaded in place is read again", () => {
    const previous = new Map([["Wave", identity("Wave", 0)]]);
    const current = new Map([["Wave", identity("Wave", 1)]]);

    expect(replacedPanes(previous, current)).toEqual(["Wave"]);
  });

  test("a pane whose url changed under the same title is read again", () => {
    const previous = new Map([["Wave", "Wave /?v=a 0"]]);
    const current = new Map([["Wave", "Wave /?v=b 0"]]);

    expect(replacedPanes(previous, current)).toEqual(["Wave"]);
  });

  test("leaving the stage and coming back changes nothing", () => {
    const stage = new Map([["Wave", identity("Wave", 0)]]);

    expect(replacedPanes(stage, new Map())).toEqual([]);
    expect(replacedPanes(new Map(), stage)).toEqual([]);
  });

  test("only the replaced pane of a split is read again", () => {
    const previous = new Map([
      ["Wave", identity("Wave", 0)],
      ["Dot grid", identity("Dot grid", 0)],
    ]);
    const current = new Map([
      ["Wave", identity("Wave", 0)],
      ["Dot grid", identity("Dot grid", 2)],
    ]);

    expect(replacedPanes(previous, current)).toEqual(["Dot grid"]);
  });
});

describe("replacedPanes across a dev-server recovery", () => {
  const identity = (title: string, generation: number) => `${title} /${title} ${generation}`;

  test("an off-stage direction reloaded by a recovery is read again", () => {
    // When the dev server returns, every app-backed direction is reloaded,
    // and most of them are off stage. Remembering only the mounted ones left
    // those with no previous identity to differ from, so the reload was
    // missed and a restart that changed the page could still be called a
    // duplicate of what it used to be.
    const before = new Map([
      ["Wave", identity("Wave", 0)],
      ["Dot grid", identity("Dot grid", 0)],
      ["Session", identity("Session", 0)],
    ]);
    const afterRecovery = new Map([
      ["Wave", identity("Wave", 1)],
      ["Dot grid", identity("Dot grid", 1)],
      ["Session", identity("Session", 1)],
    ]);

    expect(replacedPanes(before, afterRecovery).toSorted()).toEqual([
      "Dot grid",
      "Session",
      "Wave",
    ]);
  });

  test("a direction the recovery did not touch keeps its verdict", () => {
    // A file preview is served by Leglas itself and never went down with the
    // app, so its generation does not move and its reading still stands.
    const before = new Map([
      ["Wave", identity("Wave", 0)],
      ["Paper", identity("Paper", 0)],
    ]);
    const afterRecovery = new Map([
      ["Wave", identity("Wave", 1)],
      ["Paper", identity("Paper", 0)],
    ]);

    expect(replacedPanes(before, afterRecovery)).toEqual(["Wave"]);
  });
});
