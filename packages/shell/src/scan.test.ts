import { describe, expect, test } from "vitest";

import { forgetSignature, scanQueue } from "./scan.js";

const PREVIEWS = [
  { title: "Current", url: "/", tags: [] },
  { title: "Aurora", url: "/?v-hero=aurora", tags: [] },
  { title: "Staging", url: "https://staging.example.com", tags: [] },
  // A file preview reaches the shell with its mount as the url.
  { title: "Paper", url: "/leglas/files/paper/paper.html", tags: [] },
] as const;

describe("scanQueue", () => {
  test("queues unopened same-origin previews, in rail order", () => {
    expect(scanQueue(PREVIEWS, {})).toEqual(["Current", "Aurora", "Paper"]);
  });

  test("skips cross-origin previews, whose documents are sealed", () => {
    expect(scanQueue(PREVIEWS, {})).not.toContain("Staging");
  });

  test("scans mounted previews too so every signature uses one viewport", () => {
    expect(scanQueue(PREVIEWS, {})).toContain("Current");
  });

  test("skips previews already read, including ones that drew nothing", () => {
    // null is a verdict ("nothing worth comparing"), not an absence; treating
    // it as unread would rescan the same empty page forever.
    expect(
      scanQueue(PREVIEWS, { Current: "sig", Aurora: null, Paper: "sig" }),
    ).toEqual([]);
  });

  test("previews that appear mid-session join the queue", () => {
    const grown = [...PREVIEWS, { title: "New", url: "/?v-hero=new", tags: [] }];
    expect(
      scanQueue(grown, { Current: "sig", Aurora: "sig", Paper: "sig" }),
    ).toEqual(["New"]);
  });
});

describe("forgetSignature", () => {
  test("invalidates only the preview that navigated", () => {
    expect(forgetSignature({ Current: "old", Aurora: "keep" }, "Current")).toEqual({
      Aurora: "keep",
    });
  });

  test("preserves identity when no verdict exists", () => {
    const signatures = { Aurora: "keep" };
    expect(forgetSignature(signatures, "Current")).toBe(signatures);
  });
});
