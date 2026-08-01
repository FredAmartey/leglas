import { describe, expect, test } from "vitest";

import { nextCompare, paneTitles } from "./compare.js";

describe("nextCompare", () => {
  test("opens against whatever you were just looking at", () => {
    // The comparison you want is almost always against the direction you came
    // from, so opening the split needs no second choice.
    expect(nextCompare({ active: "Quiet", previous: "Current", pinned: null })).toBe("Current");
  });

  test("falls back to the first other direction when there is no history", () => {
    expect(
      nextCompare({ active: "Quiet", previous: null, pinned: null, rows: ["Quiet", "Kinetic"] }),
    ).toBe("Kinetic");
  });

  test("honours a pinned direction over history", () => {
    expect(nextCompare({ active: "Quiet", previous: "Current", pinned: "Kinetic" })).toBe("Kinetic");
  });

  test("never compares a direction against itself", () => {
    expect(nextCompare({ active: "Quiet", previous: "Quiet", pinned: null, rows: ["Quiet"] })).toBeNull();
  });

  test("drops a pin that no longer exists", () => {
    expect(
      nextCompare({ active: "Quiet", previous: null, pinned: "Deleted", rows: ["Quiet", "Kinetic"] }),
    ).toBe("Kinetic");
  });

  test("returns nothing when there is only one direction to show", () => {
    expect(nextCompare({ active: "Only", previous: null, pinned: null, rows: ["Only"] })).toBeNull();
  });
});

describe("paneTitles", () => {
  test("shows one pane when the split is off", () => {
    expect(paneTitles({ active: "Quiet", compare: "Current", split: false })).toEqual(["Quiet"]);
  });

  test("shows both panes when the split is on, active on the left", () => {
    expect(paneTitles({ active: "Quiet", compare: "Current", split: true })).toEqual([
      "Quiet",
      "Current",
    ]);
  });

  test("falls back to one pane when there is nothing to compare against", () => {
    expect(paneTitles({ active: "Quiet", compare: null, split: true })).toEqual(["Quiet"]);
  });

  test("never renders the same direction twice", () => {
    expect(paneTitles({ active: "Quiet", compare: "Quiet", split: true })).toEqual(["Quiet"]);
  });
});
