import { describe, expect, test } from "vitest";

import { LABEL_ROOM, setLayout, nextCompare, paneGeometry, paneTitles } from "./compare.js";

test("nextCompare picks the second pane with no second choice needed", () => {
  const rows = ["Quiet", "Kinetic"];

  // The comparison you want is almost always against where you came from.
  expect(nextCompare({ active: "Quiet", previous: "Current", pinned: null })).toBe("Current");
  // With no history, the first other direction.
  expect(nextCompare({ active: "Quiet", previous: null, pinned: null, rows })).toBe("Kinetic");
  // A pin beats history; a pin that no longer exists is dropped.
  expect(nextCompare({ active: "Quiet", previous: "Current", pinned: "Kinetic" })).toBe("Kinetic");
  expect(nextCompare({ active: "Quiet", previous: null, pinned: "Deleted", rows })).toBe("Kinetic");
  // Never a direction against itself, and nothing when it is the only one.
  expect(
    nextCompare({ active: "Quiet", previous: "Quiet", pinned: null, rows: ["Quiet"] }),
  ).toBeNull();
  expect(nextCompare({ active: "Only", previous: null, pinned: null, rows: ["Only"] })).toBeNull();

  // A variant's question is "how far is this from the original": its parent
  // beats history, a pin still beats the parent, and a parent off the rail
  // falls back to history.
  const variant = {
    active: "Meridian Dusk",
    parent: "Meridian",
    rows: ["Meridian", "Meridian Dusk", "Bulletin"],
  };

  expect(nextCompare({ ...variant, previous: "Bulletin", pinned: null })).toBe("Meridian");
  expect(nextCompare({ ...variant, previous: null, pinned: "Bulletin" })).toBe("Bulletin");
  expect(
    nextCompare({
      ...variant,
      previous: "Bulletin",
      pinned: null,
      rows: ["Meridian Dusk", "Bulletin"],
    }),
  ).toBe("Bulletin");
});

test("paneTitles shows both panes only for a split with another direction, active on the left", () => {
  expect(paneTitles({ active: "Quiet", compare: "Current", split: false })).toEqual(["Quiet"]);
  expect(paneTitles({ active: "Quiet", compare: "Current", split: true })).toEqual([
    "Quiet",
    "Current",
  ]);
  expect(paneTitles({ active: "Quiet", compare: null, split: true })).toEqual(["Quiet"]);
  expect(paneTitles({ active: "Quiet", compare: "Quiet", split: true })).toEqual(["Quiet"]);
});

describe("how one side of a split is drawn", () => {
  const stage = {
    gutter: 48,
    scaleSplit: true,
    stageHeight: 950,
    stageWidth: 1358,
    viewport: null,
  };

  test("a single pane is left alone", () => {
    const geometry = paneGeometry({ ...stage, panes: 1 });
    expect(geometry.scaling).toBe(false);
    expect(geometry.scale).toBe(1);
    expect(geometry.designWidth).toBe(1358);
  });

  test("a split keeps the width it had alone and scales to fit", () => {
    const geometry = paneGeometry({ ...stage, panes: 2 });
    // The design is still drawn at the stage's full width, the width its
    // breakpoints were written for.
    expect(geometry.designWidth).toBe(1358);
    expect(geometry.scale).toBeCloseTo(0.5, 2);
    expect(geometry.scaling).toBe(true);
    // The scaled frame lands inside one pane.
    expect(geometry.boxWidth).toBeCloseTo((1358 - 1) / 2, 0);
    // Same window shape as alone, only smaller, so nothing stretches. Filling
    // the pane would draw a viewport-height hero in a window twice as tall.
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

  test("a set shown whole keeps the design's width and fits each cell, name included", () => {
    // Six in three columns: a cell is (1358 - 2) / 3 wide, and width binds.
    const six = paneGeometry({ ...stage, panes: 3, rows: 2 });
    expect(six.designWidth).toBe(1358);
    expect(six.scale).toBeCloseTo(452 / 1358, 3);

    // Four sit two by two: a cell is 678.5 wide but only (950 - 1) / 2 tall, so
    // its height less the name above binds.
    const four = paneGeometry({ ...stage, panes: 2, rows: 2 });
    expect(four.scale).toBeCloseTo((474.5 - LABEL_ROOM) / 950, 3);
    expect(four.boxHeight + LABEL_ROOM).toBeCloseTo(474.5, 1);
    expect(four.boxWidth).toBeLessThan(678.5);
  });

  test("an inset keeps room around each frame in a set shown whole", () => {
    const tight = paneGeometry({ ...stage, panes: 3 });
    const spaced = paneGeometry({ ...stage, panes: 3, inset: 32 });

    expect(tight.boxWidth).toBeCloseTo(452, 0);
    expect(spaced.boxWidth).toBeCloseTo(452 - 32, 0);
  });

  test("a set is laid out one row for up to three, then two rows, never three and one", () => {
    expect([2, 3, 4, 5, 6].map((count) => setLayout(count))).toEqual([
      { columns: 2, rows: 1 },
      { columns: 3, rows: 1 },
      { columns: 2, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 2 },
    ]);
  });

  test("a preset narrower than the pane is never scaled up, and its box is its own size", () => {
    const geometry = paneGeometry({ ...stage, panes: 2, viewport: 390 });
    expect(geometry.scale).toBe(1);
    expect(geometry.scaling).toBe(false);
    expect(geometry.boxWidth).toBe(390);
    // Unsplit, a preset is inset by the gutter.
    expect(geometry.boxHeight).toBe(902);
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

describe("a framed preset inside a split", () => {
  const stage = { gutter: 48, panes: 2, scaleSplit: true, stageHeight: 950, stageWidth: 1358 };

  test("is scaled from the height it has unsplit, not the whole stage", () => {
    const geometry = paneGeometry({ ...stage, viewport: 1440 });
    // Unsplit, a preset is inset by the gutter, so its height is the stage less
    // the gutter. Scaling from 950 would draw it 48px taller and move every vh
    // in the design.
    expect(geometry.frameHeight).toBe(902);
    expect(geometry.boxWidth / geometry.boxHeight).toBeCloseTo(1440 / 902, 3);
  });
});

describe("sub-pixel stage widths", () => {
  test("the design width is not rounded, so a breakpoint cannot land differently", () => {
    // The stage measures fractionally and the unsplit view uses that exact
    // width. Rounding to 1359 would put a 1358.5px breakpoint on the other side
    // in a split.
    const geometry = paneGeometry({
      gutter: 48,
      panes: 2,
      scaleSplit: true,
      stageHeight: 950,
      stageWidth: 1358.6,
      viewport: null,
    });

    expect(geometry.designWidth).toBe(1358.6);
  });
});
