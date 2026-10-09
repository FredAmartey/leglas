import { describe, expect, test } from "vitest";

import { ORB_MOODS, orbMood } from "./orb.js";

describe("orbMood", () => {
  test("spreads rolls across every mood", () => {
    const seen = new Set(ORB_MOODS.map((_, index) => orbMood((index + 0.5) / ORB_MOODS.length)));

    expect(seen.size).toBe(ORB_MOODS.length);
  });

  test("keeps every roll on the list, clamping one out of range to the nearer end", () => {
    const [first, last] = [ORB_MOODS[0], ORB_MOODS[ORB_MOODS.length - 1]];

    expect(orbMood(0)).toBe(first);
    expect(orbMood(0.999999)).toBe(last);
    expect(orbMood(1)).toBe(last);
    expect(orbMood(-0.5)).toBe(first);
  });
});
