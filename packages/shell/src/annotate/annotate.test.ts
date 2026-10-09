import { describe, expect, test } from "vitest";

import {
  boxBetween,
  boxFromFractions,
  cardWidth,
  contains,
  coversFrom,
  fractionsIn,
  isDrag,
  overlaps,
  placeCard,
  unionOf,
} from "./annotate.js";

test("a press that wobbles is still a click, and a deliberate sweep is a region", () => {
  expect(isDrag({ x: 100, y: 100 }, { x: 103, y: 102 })).toBe(false);
  expect(isDrag({ x: 100, y: 100 }, { x: 140, y: 101 })).toBe(true);
  expect(isDrag({ x: 100, y: 100 }, { x: 101, y: 140 })).toBe(true);
});

test("boxBetween reads the same box dragged in any direction", () => {
  const forward = boxBetween({ x: 10, y: 20 }, { x: 110, y: 70 });

  expect(forward).toEqual({ height: 50, width: 100, x: 10, y: 20 });
  expect(boxBetween({ x: 110, y: 70 }, { x: 10, y: 20 })).toEqual(forward);
});

test("an element crossing a region's edge overlaps it, one inside is contained, and touching is neither", () => {
  const region = { height: 100, width: 100, x: 0, y: 0 };
  const straddling = { height: 20, width: 20, x: 90, y: 10 };
  const inside = { height: 20, width: 20, x: 10, y: 10 };

  expect([overlaps(region, straddling), contains(region, straddling)]).toEqual([true, false]);
  expect([overlaps(region, inside), contains(region, inside)]).toEqual([true, true]);
  expect(overlaps(region, { height: 10, width: 10, x: 100, y: 0 })).toBe(false);
});

describe("fractionsIn and boxFromFractions", () => {
  const outer = { height: 200, width: 400, x: 100, y: 100 };

  test("records a region as a share of what holds it", () => {
    expect(fractionsIn(outer, { height: 50, width: 100, x: 200, y: 150 })).toEqual({
      height: 0.25,
      width: 0.25,
      x: 0.25,
      y: 0.25,
    });
  });

  // The container is a different size next time, and the region still means the
  // same part of it.
  test("puts a region back proportionally when the container has resized", () => {
    const region = fractionsIn(outer, { height: 50, width: 100, x: 200, y: 150 });
    const wider = { height: 400, width: 800, x: 0, y: 0 };

    expect(boxFromFractions(wider, region)).toEqual({
      height: 100,
      width: 200,
      x: 200,
      y: 100,
    });
  });

  test("survives a container with no size to divide by", () => {
    expect(
      fractionsIn({ height: 0, width: 0, x: 0, y: 0 }, { height: 5, width: 5, x: 0, y: 0 }),
    ).toEqual({ height: 1, width: 1, x: 0, y: 0 });
  });
});

describe("placeCard", () => {
  const card = { height: 80, width: 256 };
  const bounds = { height: 900, width: 1440 };
  const element = { height: 40, width: 300, x: 400, y: 300 };

  test("sits under the element, aligned to its left edge", () => {
    expect(placeCard({ anchor: element, bounds, card })).toEqual({
      flipped: false,
      left: 400,
      top: 348,
    });
  });

  // Flipping above the element's bottom edge would park the card on the thing
  // it's asking about.
  test("flips clear of the element rather than onto it", () => {
    const low = { height: 40, width: 300, x: 400, y: 860 };
    const placed = placeCard({ anchor: low, bounds, card });

    expect(placed.flipped).toBe(true);
    expect(placed.top).toBe(772);
    expect(placed.top + card.height).toBeLessThanOrEqual(low.y);
  });

  test("aligns to the right edge rather than hanging off it, and stays on screen in a corner", () => {
    expect(placeCard({ anchor: { ...element, x: 1380 }, bounds, card }).left).toBe(1184);
    // In the corner both rules would fail.
    expect(
      placeCard({ anchor: { height: 40, width: 40, x: 1430, y: 870 }, bounds, card }),
    ).toMatchObject({ left: 1184, top: 782 });
  });

  // A phone preview is narrower than the card's ideal width; top left is the
  // only placement showing all of it.
  test("gives up gracefully when the viewport cannot hold the card", () => {
    expect(
      placeCard({
        anchor: { height: 10, width: 10, x: 10, y: 10 },
        bounds: { height: 60, width: 200 },
        card,
      }),
    ).toEqual({ flipped: false, left: 0, top: 0 });
  });
});

test("cardWidth is comfortable on a pane, gives up width before the margin, and never too narrow to type in", () => {
  // A desktop pane, and a phone preview with room to spare.
  expect([cardWidth(1440), cardWidth(390)]).toEqual([256, 256]);
  expect(cardWidth(280)).toBe(232);
  expect(cardWidth(200)).toBe(180);
  expect(cardWidth(0)).toBe(256);
});

test("unionOf holds everything it was given, and nothing when the sweep caught nothing", () => {
  const only = { height: 40, width: 100, x: 10, y: 20 };

  expect(unionOf([only, { height: 20, width: 60, x: 200, y: 100 }])).toEqual({
    height: 100,
    width: 250,
    x: 10,
    y: 20,
  });
  expect(unionOf([only])).toEqual(only);
  expect(unionOf([])).toBeNull();
});

test("coversFrom keeps what was given in order, says a thing once, and caps a big region", () => {
  const h1 = { tag: "h1", text: "Dried fruit" };
  const p = { tag: "p", text: "Made in Ghana" };

  expect(coversFrom([h1, p, { ...h1 }])).toEqual([h1, p]);
  // A region dragged over half the page.
  expect(
    coversFrom(Array.from({ length: 40 }, (_, at) => ({ tag: "div", text: `row ${at}` }))),
  ).toHaveLength(8);
});
