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

describe("isDrag", () => {
  test("a press that wobbles is still a click", () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 103, y: 102 })).toBe(false);
  });

  test("a deliberate sweep is a region", () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 140, y: 101 })).toBe(true);
    expect(isDrag({ x: 100, y: 100 }, { x: 101, y: 140 })).toBe(true);
  });
});

describe("boxBetween", () => {
  test("reads the same box dragged in any direction", () => {
    const forward = boxBetween({ x: 10, y: 20 }, { x: 110, y: 70 });
    const backward = boxBetween({ x: 110, y: 70 }, { x: 10, y: 20 });

    expect(forward).toEqual({ height: 50, width: 100, x: 10, y: 20 });
    expect(backward).toEqual(forward);
  });
});

describe("overlaps and contains", () => {
  const region = { height: 100, width: 100, x: 0, y: 0 };

  test("an element crossing the edge overlaps but is not contained", () => {
    const straddling = { height: 20, width: 20, x: 90, y: 10 };
    expect(overlaps(region, straddling)).toBe(true);
    expect(contains(region, straddling)).toBe(false);
  });

  test("an element wholly inside is both", () => {
    const inside = { height: 20, width: 20, x: 10, y: 10 };
    expect(overlaps(region, inside)).toBe(true);
    expect(contains(region, inside)).toBe(true);
  });

  test("touching edges is not overlapping", () => {
    expect(overlaps(region, { height: 10, width: 10, x: 100, y: 0 })).toBe(false);
  });
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

  // The point of storing fractions: the container is a different size next
  // time, and the region still means the same part of it.
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
    expect(fractionsIn({ height: 0, width: 0, x: 0, y: 0 }, { height: 5, width: 5, x: 0, y: 0 })).toEqual(
      { height: 1, width: 1, x: 0, y: 0 },
    );
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

  // The failure this exists to prevent: flipping above the bottom edge parks
  // the card on top of the very thing it is asking about.
  test("flips clear of the element rather than onto it", () => {
    const low = { height: 40, width: 300, x: 400, y: 860 };
    const placed = placeCard({ anchor: low, bounds, card });

    expect(placed.flipped).toBe(true);
    expect(placed.top).toBe(772);
    expect(placed.top + card.height).toBeLessThanOrEqual(low.y);
  });

  test("aligns to the right edge rather than hanging off it", () => {
    expect(placeCard({ anchor: { ...element, x: 1380 }, bounds, card }).left).toBe(1184);
  });

  test("stays on screen in the corner where both would fail", () => {
    const placed = placeCard({ anchor: { height: 40, width: 40, x: 1430, y: 870 }, bounds, card });

    expect(placed.left).toBe(1184);
    expect(placed.top).toBe(782);
  });

  // A phone preview is narrower than the card's ideal width, and there is no
  // placement that fits: the top left is the only answer that shows all of it.
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

describe("cardWidth", () => {
  test("is comfortable on a desktop pane", () => {
    expect(cardWidth(1440)).toBe(256);
  });

  test("still fits with room to spare on a phone preview", () => {
    expect(cardWidth(390)).toBe(256);
  });

  test("gives up width rather than the margin when the pane is tiny", () => {
    expect(cardWidth(280)).toBe(232);
  });

  test("never narrows past a slot you can type a sentence into", () => {
    expect(cardWidth(200)).toBe(180);
    expect(cardWidth(0)).toBe(256);
  });
});

describe("unionOf", () => {
  test("holds everything it was given", () => {
    expect(
      unionOf([
        { height: 40, width: 100, x: 10, y: 20 },
        { height: 20, width: 60, x: 200, y: 100 },
      ]),
    ).toEqual({ height: 100, width: 250, x: 10, y: 20 });
  });

  test("is one box when there is one box", () => {
    const only = { height: 10, width: 10, x: 5, y: 5 };
    expect(unionOf([only])).toEqual(only);
  });

  test("has nothing to hold when the sweep caught nothing", () => {
    expect(unionOf([])).toBeNull();
  });
});

describe("coversFrom", () => {
  test("keeps what was given, in order", () => {
    expect(
      coversFrom([
        { tag: "h1", text: "Dried fruit" },
        { tag: "p", text: "Made in Ghana" },
      ]),
    ).toEqual([
      { tag: "h1", text: "Dried fruit" },
      { tag: "p", text: "Made in Ghana" },
    ]);
  });

  test("says a thing once", () => {
    expect(
      coversFrom([
        { tag: "span", text: "Bag" },
        { tag: "span", text: "Bag" },
      ]),
    ).toHaveLength(1);
  });

  test("caps a region dragged over half the page", () => {
    expect(
      coversFrom(Array.from({ length: 40 }, (_, at) => ({ tag: "div", text: `row ${at}` }))),
    ).toHaveLength(8);
  });
});
