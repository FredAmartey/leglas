import { describe, expect, test } from "vitest";

import {
  forgetScans,
  recordScan,
  replacedPanes,
  scanQueue,
  scanSignatures,
  type PreviewScans,
} from "./scan.js";
import type { Preview } from "../types.js";

const PREVIEWS = [
  { title: "Current", url: "/", tags: [] },
  { title: "Aurora", url: "/?v-hero=aurora", tags: [] },
  { title: "Staging", url: "https://staging.example.com", tags: [] },
  { title: "Paper", url: "/leglas/files/paper/paper.html", tags: [] },
] as const;

describe("scanQueue", () => {
  test("a branch preview that has not started has no url yet, and is skipped rather than thrown on", () => {
    const unstarted: Partial<Preview> = { title: "Warm red", tags: [], branch: "warm-red" };
    // SAFETY: an unstarted branch preview arrives without a url, which the type
    // doesn't admit; that gap is what this tests.
    const idle = unstarted as Preview;

    expect(scanQueue([idle, ...PREVIEWS], {}).map((preview) => preview.title)).not.toContain(
      "Warm red",
    );
  });

  test("queues same-origin previews without current results, not the sealed cross-origin one", () => {
    expect(scanQueue(PREVIEWS, {}).map((preview) => preview.title)).toEqual([
      "Current",
      "Aurora",
      "Paper",
    ]);
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

    const scans = Object.fromEntries(
      PREVIEWS.flatMap((preview) =>
        preview.url.startsWith("/")
          ? [[preview.title, { url: preview.url, status: "complete", signature: "sig" }] as const]
          : [],
      ),
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

test("replacedPanes reads again only a pane whose document was replaced in place", () => {
  /** Panes by title, each at a load of its own URL. */
  const stage = (...panes: [string, string][]) => new Map(panes);

  const wave = stage(["Wave", "Wave /?v=a 0"]);

  // Flipping to a direction loads the document the background read already
  // measured; rescanning it doubled the cost of every flip.
  expect(replacedPanes(wave, stage(["Dot grid", "Dot grid /?v=d 0"]))).toEqual([]);
  // Reloaded in place, or a new URL under the same title.
  expect(replacedPanes(wave, stage(["Wave", "Wave /?v=a 1"]))).toEqual(["Wave"]);
  expect(replacedPanes(wave, stage(["Wave", "Wave /?v=b 0"]))).toEqual(["Wave"]);
  // Leaving the stage and coming back.
  expect(replacedPanes(wave, stage())).toEqual([]);
  expect(replacedPanes(stage(), wave)).toEqual([]);
  // Only the replaced pane of a split.
  expect(
    replacedPanes(
      stage(["Wave", "Wave /?v=a 0"], ["Dot grid", "Dot grid /?v=d 0"]),
      stage(["Wave", "Wave /?v=a 0"], ["Dot grid", "Dot grid /?v=d 2"]),
    ),
  ).toEqual(["Dot grid"]);
});
