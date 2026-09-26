import { describe, expect, test } from "vitest";

import {
  WIDGET_MARGIN,
  WIDGET_SIZE,
  clampWidget,
  dragAnchor,
  isDrag,
  nearestCorner,
} from "./widget.js";

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

describe("isDrag", () => {
  /**
   * The widget is a button first. Without a threshold any jitter during a tap
   * counts as a drag, which moves it and eats the click meant to open the
   * tools.
   */
  test("treats pointer travel during a tap as a click, not a drag", () => {
    const start = { x: 100, y: 100 };

    // A real trackpad press slides several pixels; 5 and 6 broke the widget
    // before this threshold.
    for (const point of [
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      { x: 100, y: 103 },
      { x: 105, y: 105 },
      { x: 106, y: 106 },
      { x: 92, y: 94 },
    ]) {
      expect(isDrag(start, point)).toBe(false);
    }
  });

  test("treats deliberate travel as a drag", () => {
    const start = { x: 100, y: 100 };
    expect(isDrag(start, { x: 120, y: 100 })).toBe(true);
    expect(isDrag(start, { x: 100, y: 60 })).toBe(true);
    expect(isDrag(start, { x: 100, y: 140 })).toBe(true);
    expect(isDrag(start, { x: 111, y: 100 })).toBe(true);
  });
});

describe("dragAnchor", () => {
  /**
   * The popover shares the widget's box and stays mounted while hidden, so
   * anchoring the box at the pointer left the button a popover away from the
   * hand.
   */
  test("centres the button on the pointer", () => {
    const pointer = { x: 640, y: 400 };
    const anchor = dragAnchor(pointer);
    expect(anchor.x + WIDGET_SIZE / 2).toBe(pointer.x);
    expect(anchor.y + WIDGET_SIZE / 2).toBe(pointer.y);
  });
});
