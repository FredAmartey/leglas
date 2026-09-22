import { expect, test } from "vitest";

import { tagTone } from "./tags.js";

test("a tag keeps its colour from one session to the next", () => {
  expect(tagTone("Hero backdrops")).toEqual(tagTone("Hero backdrops"));
});

test("the pill is the tone at full strength on a wash of itself", () => {
  const { backgroundColor, color } = tagTone("Pricing");
  expect(color).toMatch(/^#[0-9A-F]{6}$/);
  expect(backgroundColor).toBe(`${color}22`);
});

test("amber is never a tag's colour, because amber means duplicate", () => {
  const tones = new Set(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((tag) => tagTone(tag).color),
  );

  expect(tones.size).toBeGreaterThan(1);

  // Tailwind's amber-400 and amber-500, which the duplicate mark wears.
  for (const tone of tones) expect(["#FBBF24", "#F59E0B"]).not.toContain(tone);
});
