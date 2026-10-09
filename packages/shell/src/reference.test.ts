import { describe, expect, test } from "vitest";

import { absoluteUrl, referenceText } from "./reference.js";
import type { Preview } from "./types.js";

const preview = (extra: Partial<Preview> = {}): Preview => ({
  title: "Warm",
  url: "/leglas/files/Warm/warm.html",
  tags: [],
  ...extra,
});

const reference = (extra: Partial<Preview> = {}, displayName = "Warm") =>
  referenceText({
    displayName,
    preview: preview(extra),
    previewUrl: "http://localhost:4173/leglas/files/Warm/warm.html",
    title: "Warm",
  });

describe("referenceText", () => {
  test("leads with the title, note and tags", () => {
    const text = reference({ note: "Sunlit, low contrast.", tags: ["Hero", "Nav"] });
    expect(text.split("\n")[0]).toBe('Leglas direction "Warm" — Sunlit, low contrast. [Hero, Nav]');
  });

  test("says nothing where there is nothing to say", () => {
    expect(reference().split("\n")[0]).toBe('Leglas direction "Warm"');
  });

  // Commands address directions by config title, so a renamed row must carry
  // both or the reference names something the CLI can't find.
  test("prints both names when the rail shows a different one, and points at the config title", () => {
    const renamed = reference({}, "Sunrise");

    expect(renamed.split("\n")[0]).toBe('Leglas direction "Warm" (shown as "Sunrise")');
    expect(renamed).toContain('npx leglas show "Warm" --json');
  });

  test("names the source an agent edits: a file over the route, a branch, or the route", () => {
    const file = reference({ file: "pages/warm.html" });

    expect(file).toContain("Source: pages/warm.html");
    expect(file).not.toContain("Route:");
    expect(reference({ branch: "web/landing-hero" })).toContain("Branch: web/landing-hero");
    expect(reference({ url: "/?v-hero=wave" })).toContain("Route: /?v-hero=wave");
  });

  test("carries the parent of a variant, and no parent line for a root", () => {
    expect(reference({ basedOn: "Cool" })).toContain("A variant of: Cool");
    expect(reference()).not.toContain("A variant of:");
  });

  test("always ends with the way to get the rest, addressed by config title", () => {
    expect(reference()).toMatch(
      /Inspect this direction in full:\n {2}npx leglas show "Warm" --json$/,
    );
  });

  test("survives a title it has no preview for", () => {
    const text = referenceText({
      displayName: "Gone",
      preview: undefined,
      previewUrl: "http://localhost:4173/",
      title: "Gone",
    });

    expect(text).toContain('Leglas direction "Gone"');
    expect(text).toContain("Preview: http://localhost:4173/");
  });
});

test("absoluteUrl resolves a root-relative preview against the shell's origin, and leaves the rest", () => {
  const shell = "http://localhost:4173";

  expect(absoluteUrl("/?v-hero=wave", shell)).toBe("http://localhost:4173/?v-hero=wave");
  // A branch preview runs on its own port and a config may point at staging;
  // concatenating an origin onto either goes nowhere.
  expect(absoluteUrl("http://localhost:5174/", shell)).toBe("http://localhost:5174/");
  // The raw value rather than a throw.
  expect(absoluteUrl("not a url", "also not a url")).toBe("not a url");
});
