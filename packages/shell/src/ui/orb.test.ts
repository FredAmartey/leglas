import { describe, expect, test } from "vitest";

import { ORB_MOODS, orbMood } from "./orb.js";

describe("orbMood", () => {
  test("spreads rolls across every mood", () => {
    const seen = new Set(ORB_MOODS.map((_, index) => orbMood((index + 0.5) / ORB_MOODS.length)));

    expect(seen.size).toBe(ORB_MOODS.length);
  });

  test("the smallest roll lands on the first mood", () => {
    expect(orbMood(0)).toBe(ORB_MOODS[0]);
  });

  test("a roll just under one lands on the last mood", () => {
    expect(orbMood(0.999999)).toBe(ORB_MOODS[ORB_MOODS.length - 1]);
  });

  test("clamps a roll of exactly one instead of reading past the end", () => {
    expect(orbMood(1)).toBe(ORB_MOODS[ORB_MOODS.length - 1]);
  });

  test("clamps a negative roll instead of reading before the start", () => {
    expect(orbMood(-0.5)).toBe(ORB_MOODS[0]);
  });
});
