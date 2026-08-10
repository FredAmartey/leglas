import { describe, expect, test } from "vitest";

import { nextCompare, paneGeometry, paneTitles } from "./compare.js";

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

describe("how one side of a split is drawn", () => {
  const stage = { gutter: 48, scaleSplit: true, stageHeight: 950, stageWidth: 1358, viewport: null };

  test("a single pane is left alone", () => {
    const geometry = paneGeometry({ ...stage, panes: 1 });
    expect(geometry.scaling).toBe(false);
    expect(geometry.scale).toBe(1);
    expect(geometry.designWidth).toBe(1358);
  });

  test("a split keeps the width it had alone and scales to fit", () => {
    const geometry = paneGeometry({ ...stage, panes: 2 });
    // The design is still drawn at the stage's full width: this is the whole
    // point, since that is the width its breakpoints were written for.
    expect(geometry.designWidth).toBe(1358);
    expect(geometry.scale).toBeCloseTo(0.5, 2);
    expect(geometry.scaling).toBe(true);
    // The scaled frame lands inside one pane.
    expect(geometry.boxWidth).toBeCloseTo((1358 - 1) / 2, 0);
  });

  test("the frame keeps the stage's proportions, so nothing stretches", () => {
    const geometry = paneGeometry({ ...stage, panes: 2 });
    // Same window shape as looking at it alone, only smaller. Filling the pane
    // instead would draw a viewport-height hero in a window twice as tall.
    expect(geometry.frameHeight).toBe(950);
    expect(geometry.boxWidth / geometry.boxHeight).toBeCloseTo(1358 / 950, 2);
  });

  test("turning it off gives the pane back to the app, which is the old behaviour", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, scaleSplit: false });
    expect(geometry.scaling).toBe(false);
    expect(geometry.scale).toBe(1);
  });

  test("a viewport preset is what gets scaled, so presets survive a split", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, viewport: 1440 });
    expect(geometry.designWidth).toBe(1440);
    // 1440 has to fit a ~678px pane minus its gutter.
    expect(geometry.scale).toBeCloseTo((678.5 - 48) / 1440, 2);
  });

  test("a preset narrower than the pane is never scaled up", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, viewport: 390 });
    expect(geometry.scale).toBe(1);
    expect(geometry.scaling).toBe(false);
  });

  test("a stage not measured yet does not divide by zero", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, stageHeight: 0, stageWidth: 0 });
    expect(Number.isFinite(geometry.scale)).toBe(true);
    expect(Number.isFinite(geometry.frameHeight)).toBe(true);
    expect(geometry.scaling).toBe(false);
  });

  test("a pane dragged to nothing still yields a usable scale", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, stageWidth: 40, viewport: 1440 });
    expect(geometry.scale).toBeGreaterThan(0);
    expect(Number.isFinite(geometry.frameHeight)).toBe(true);
  });
});
