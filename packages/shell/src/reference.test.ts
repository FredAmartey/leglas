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

  // Every command addresses a direction by its config title, so a renamed row
  // has to carry both or the reference names something the CLI cannot find.
  test("prints both names when the rail shows a different one", () => {
    expect(reference({}, "Sunrise").split("\n")[0]).toBe(
      'Leglas direction "Warm" (shown as "Sunrise")',
    );
  });

  test("names the file a file-backed direction is built from", () => {
    expect(reference({ file: "pages/warm.html" })).toContain("Source: pages/warm.html");
  });

  test("names the branch a branch-backed direction runs from", () => {
    expect(reference({ branch: "web/landing-hero" })).toContain("Branch: web/landing-hero");
  });

  test("names the route for an ordinary direction", () => {
    expect(reference({ url: "/?v-hero=wave" })).toContain("Route: /?v-hero=wave");
  });

  test("prefers the file over the route, since that is what an agent edits", () => {
    const text = reference({ file: "pages/warm.html" });
    expect(text).toContain("Source: pages/warm.html");
    expect(text).not.toContain("Route:");
  });

  test("carries the parent of a variant", () => {
    expect(reference({ basedOn: "Cool" })).toContain("A variant of: Cool");
  });

  test("omits the parent line for a root direction", () => {
    expect(reference()).not.toContain("A variant of:");
  });

  test("always ends with the way to get the rest, addressed by config title", () => {
    expect(reference()).toMatch(/Inspect this direction in full:\n {2}npx leglas show "Warm" --json$/);
  });

  // The rail shows the renamed row, but only the config title reaches the CLI.
  test("points at the config title even when the row was renamed", () => {
    expect(reference({}, "Sunrise")).toContain('npx leglas show "Warm" --json');
  });

  test("leaks no absolute filesystem path", () => {
    const text = reference({ file: "pages/warm.html", note: "Sunlit." });
    expect(text).not.toMatch(/(^|\s)\//m);
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

describe("absoluteUrl", () => {
  test("resolves a root-relative preview against the shell's origin", () => {
    expect(absoluteUrl("/?v-hero=wave", "http://localhost:4173")).toBe(
      "http://localhost:4173/?v-hero=wave",
    );
  });

  // A branch preview runs on its own port, and a config may point at staging.
  // Concatenating an origin onto either produces a URL that goes nowhere.
  test("leaves an already absolute preview alone", () => {
    expect(absoluteUrl("http://localhost:5174/", "http://localhost:4173")).toBe(
      "http://localhost:5174/",
    );
  });

  test("falls back to the raw value rather than throwing", () => {
    expect(absoluteUrl("not a url", "also not a url")).toBe("not a url");
  });
});
