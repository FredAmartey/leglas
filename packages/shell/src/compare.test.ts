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

describe("a variant's default comparison", () => {
  test("prefers the direction it is based on over history", () => {
    // The question a variant set asks is "how far is this from the original".
    expect(
      nextCompare({
        active: "Meridian Dusk",
        previous: "Bulletin",
        pinned: null,
        parent: "Meridian",
        rows: ["Meridian", "Meridian Dusk", "Bulletin"],
      }),
    ).toBe("Meridian");
  });

  test("an explicit pin still beats the parent", () => {
    expect(
      nextCompare({
        active: "Meridian Dusk",
        previous: null,
        pinned: "Bulletin",
        parent: "Meridian",
        rows: ["Meridian", "Meridian Dusk", "Bulletin"],
      }),
    ).toBe("Bulletin");
  });

  test("a parent that is not on the rail falls back to history", () => {
    expect(
      nextCompare({
        active: "Meridian Dusk",
        previous: "Bulletin",
        pinned: null,
        parent: "Meridian",
        rows: ["Meridian Dusk", "Bulletin"],
      }),
    ).toBe("Bulletin");
  });
});
