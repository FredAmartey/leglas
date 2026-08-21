import { describe, expect, test } from "vitest";

import {
  forgetScans,
  recordScan,
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
