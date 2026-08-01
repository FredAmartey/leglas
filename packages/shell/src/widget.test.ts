import { describe, expect, test } from "vitest";

import { WIDGET_MARGIN, clampWidget, nearestCorner } from "./widget.js";

const stage = { width: 1000, height: 800 };

describe("clampWidget", () => {
  test("keeps the widget inside the stage", () => {
    expect(clampWidget({ x: 5000, y: 5000 }, stage)).toEqual({
      x: 1000 - WIDGET_MARGIN,
      y: 800 - WIDGET_MARGIN,
    });
  });

  test("keeps it off the top and left edges too", () => {
    expect(clampWidget({ x: -80, y: -80 }, stage)).toEqual({
      x: WIDGET_MARGIN,
      y: WIDGET_MARGIN,
    });
  });

  test("leaves a position that is already inside alone", () => {
    expect(clampWidget({ x: 400, y: 300 }, stage)).toEqual({ x: 400, y: 300 });
  });

  test("survives a stage smaller than the margins without inverting", () => {
    const tiny = clampWidget({ x: 10, y: 10 }, { width: 20, height: 20 });

    expect(tiny.x).toBeGreaterThanOrEqual(0);
    expect(tiny.y).toBeGreaterThanOrEqual(0);
  });
});

describe("nearestCorner", () => {
  test("snaps to the bottom right", () => {
    expect(nearestCorner({ x: 900, y: 700 }, stage)).toEqual({ corner: "bottom-right" });
  });

  test("snaps to the top left", () => {
    expect(nearestCorner({ x: 100, y: 100 }, stage)).toEqual({ corner: "top-left" });
  });

  test("snaps to the bottom left", () => {
    expect(nearestCorner({ x: 100, y: 700 }, stage)).toEqual({ corner: "bottom-left" });
  });

  test("snaps to the top right", () => {
    expect(nearestCorner({ x: 900, y: 100 }, stage)).toEqual({ corner: "top-right" });
  });

  test("treats the exact centre as bottom right, matching where it starts", () => {
    expect(nearestCorner({ x: 500, y: 400 }, stage)).toEqual({ corner: "bottom-right" });
  });
});
