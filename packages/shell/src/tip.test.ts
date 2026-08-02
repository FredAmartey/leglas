import { describe, expect, test } from "vitest";

import { TIP_MARGIN, fitShift, shouldFlipBelow } from "./tip.js";

const edges = (left: number, top: number, width: number, height: number) => ({
  bottom: top + height,
  left,
  right: left + width,
  top,
});

const VIEWPORT = { height: 996, width: 1728 };

describe("fitShift", () => {
  test("leaves a tooltip that already fits alone", () => {
    expect(fitShift(edges(800, 400, 120, 26), VIEWPORT.width)).toBe(0);
  });

  test("pulls in a tooltip that runs past the right edge", () => {
    // The widget parked bottom right measured a right edge of 1739 on a
    // 1728 viewport, so its label was cut off.
    const shift = fitShift(edges(1649, 901, 90, 26), VIEWPORT.width);
    expect(shift).toBeLessThan(0);
    expect(1739 + shift).toBeLessThanOrEqual(VIEWPORT.width - TIP_MARGIN);
  });

  test("pushes out a tooltip that runs past the left edge", () => {
    const shift = fitShift(edges(-20, 400, 120, 26), VIEWPORT.width);
    expect(-20 + shift).toBe(TIP_MARGIN);
  });

  test("applying the shift once is enough", () => {
    const rect = edges(1649, 901, 90, 26);
    const shift = fitShift(rect, VIEWPORT.width);
    const moved = edges(rect.left + shift, rect.top, rect.right - rect.left, 26);
    expect(fitShift(moved, VIEWPORT.width)).toBe(0);
  });

  test("pins a tooltip wider than the viewport to the left edge", () => {
    const shift = fitShift(edges(-40, 400, VIEWPORT.width + 200, 26), VIEWPORT.width);
    expect(-40 + shift).toBe(TIP_MARGIN);
  });
});

describe("shouldFlipBelow", () => {
  test("flips when the tooltip is cut off at the top", () => {
    // The widget in a top corner measured a top edge of -19.
    expect(shouldFlipBelow(edges(365, -19, 90, 26), edges(383, 15, 44, 44), VIEWPORT.height)).toBe(
      true,
    );
  });

  test("stays put when there is room above", () => {
    expect(
      shouldFlipBelow(edges(1649, 901, 90, 26), edges(1668, 936, 44, 44), VIEWPORT.height),
    ).toBe(false);
  });

  test("stays put when below is no better", () => {
    // A viewport too short for either placement: moving gains nothing.
    expect(shouldFlipBelow(edges(10, -19, 90, 26), edges(10, 15, 44, 44), 60)).toBe(false);
  });
});
