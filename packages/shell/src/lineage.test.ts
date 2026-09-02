import { describe, expect, test } from "vitest";

import {
  ancestry,
  collapseChain,
  lineageRail,
  reorderAmongSiblings,
  segmentsOf,
  tracedChain,
  tracedSegments,
  tracedTree,
  trailPath,
  widestLane,
} from "./lineage.js";

const basedOn = (pairs: [string, string][]) => new Map(pairs);

// The exploration that motivated this: one direction iterated five times,
// with a single fork off the third pass, registered in the order it was built.
const CHAIN = basedOn([
  ["Dusk", "Meridian"],
  ["Sea", "Dusk"],
  ["Harbour", "Sea"],
  ["Quay", "Harbour"],
  ["Ferry", "Harbour"],
  ["Lantern", "Quay"],
]);
const CHAIN_WITH_TIDE = new Map([...CHAIN, ["Tide", "Quay"]]);
const SAVED_WITH_TIDE = [
  "Current",
  "Ledger",
  "Meridian",
  "Dusk",
  "Sea",
  "Harbour",
  "Quay",
  "Ferry",
  "Lantern",
  "Tide",
];
const SAVED = [
  "Current",
  "Ledger",
  "Meridian",
  "Dusk",
  "Sea",
  "Harbour",
  "Quay",
  "Ferry",
  "Lantern",
];

describe("lineageRail", () => {
  test("each variant follows the direction it came from", () => {
    const { rows } = lineageRail(SAVED, CHAIN, new Set());

    expect(rows).toEqual([
      "Current",
      "Ledger",
      "Meridian",
      "Dusk",
      "Sea",
      "Harbour",
      "Quay",
      "Lantern",
      "Ferry",
    ]);
  });

  test("depth is the real depth, for a rail that wants to show it", () => {
    const { meta } = lineageRail(SAVED, CHAIN, new Set());

    expect(meta.get("Meridian")?.depth).toBe(0);
    expect(meta.get("Harbour")?.depth).toBe(3);
    expect(meta.get("Lantern")?.depth).toBe(5);
    expect(meta.get("Ferry")?.depth).toBe(4);
  });

  test("a chain is one lane and a fork opens a second", () => {
    const { meta } = lineageRail(SAVED, CHAIN, new Set());
    const graph = (title: string) => meta.get(title)?.graph;

    // The root opens the line; nothing arrives from above it.
    expect(graph("Meridian")).toMatchObject({ lane: 0, fromAbove: false, toBelow: true });
    // Harbour has two children: Quay continues lane 0, Ferry forks to lane 1.
    expect(graph("Harbour")).toMatchObject({ lane: 0, forks: [1], through: [] });
    // Ferry's lane runs past Quay and Lantern until its own row.
    expect(graph("Quay")).toMatchObject({ lane: 0, through: [1], toBelow: true });
    expect(graph("Lantern")).toMatchObject({ lane: 0, through: [1], toBelow: false });
    expect(graph("Ferry")).toMatchObject({ lane: 1, fromAbove: true, toBelow: false, through: [] });
    expect(widestLane(meta)).toBe(1);
  });

  test("a direction with no family is a mark with no lines", () => {
    const { meta } = lineageRail(SAVED, CHAIN, new Set());

    expect(meta.get("Current")?.graph).toMatchObject({
      lane: 0,
      fromAbove: false,
      toBelow: false,
      forks: [],
      through: [],
    });
    expect(widestLane(new Map([["Current", meta.get("Current")!]]))).toBe(0);
  });

  test("a rail drawn in family order has no gutter", () => {
    expect(widestLane(new Map())).toBe(-1);
  });

  test("a hidden direction hands its variants to the nearest one still showing", () => {
    const { rows, meta } = lineageRail(
      SAVED.filter((title) => title !== "Quay"),
      CHAIN,
      new Set(),
    );

    // Lantern now sits among Harbour's children, after Ferry, which the
    // saved order puts first: Ferry carries the line and Lantern forks.
    expect(rows.slice(rows.indexOf("Harbour"))).toEqual(["Harbour", "Ferry", "Lantern"]);
    expect(meta.get("Lantern")).toMatchObject({ depth: 4, graph: { lane: 1, fromAbove: true } });
    expect(meta.get("Harbour")?.graph?.forks).toEqual([1]);
  });

  test("a folded root keeps its row, drops the family, and still counts it", () => {
    const { rows, meta } = lineageRail(SAVED, CHAIN, new Set(["Meridian"]));

    expect(rows).toEqual(["Current", "Ledger", "Meridian"]);
    expect(meta.get("Meridian")).toMatchObject({ variants: 6, folded: true });
    expect(meta.get("Meridian")?.graph?.toBelow).toBe(false);
  });

  test("the family count on a root is everything beneath it", () => {
    const { meta } = lineageRail(SAVED, CHAIN, new Set());

    expect(meta.get("Meridian")?.variants).toBe(6);
    expect(meta.get("Harbour")?.variants).toBe(0);
    expect(meta.get("Harbour")?.descendants).toBe(3);
    expect(meta.get("Lantern")?.descendants).toBe(0);
  });

  test("a row at any depth can fold what is beneath it", () => {
    const { rows, meta } = lineageRail(SAVED, CHAIN, new Set(["Quay"]));

    expect(rows).not.toContain("Lantern");
    expect(rows).toContain("Ferry");
    expect(meta.get("Quay")).toMatchObject({ folded: true, descendants: 1, graph: { toBelow: false } });
  });

  test("the rail names each row's parent and children", () => {
    const { parents, children, roots } = lineageRail(SAVED, CHAIN, new Set());

    expect(roots).toEqual(["Current", "Ledger", "Meridian"]);
    expect(parents.get("Lantern")).toBe("Quay");
    expect(children.get("Harbour")).toEqual(["Quay", "Ferry"]);
  });

  test("siblings keep their saved order, and the first one carries the line", () => {
    const swapped = SAVED.filter((title) => title !== "Ferry");
    swapped.splice(swapped.indexOf("Quay"), 0, "Ferry");
    const { rows, meta } = lineageRail(swapped, CHAIN, new Set());

    expect(rows.slice(rows.indexOf("Harbour"))).toEqual(["Harbour", "Ferry", "Quay", "Lantern"]);
    expect(meta.get("Ferry")?.graph?.lane).toBe(0);
    expect(meta.get("Quay")?.graph?.lane).toBe(1);
  });

  test("two directions based on each other still both appear", () => {
    const { rows } = lineageRail(
      ["A", "B"],
      basedOn([
        ["A", "B"],
        ["B", "A"],
      ]),
      new Set(),
    );

    expect(rows.sort()).toEqual(["A", "B"]);
  });

  test("previews with no basedOn behave exactly as before", () => {
    const { rows, meta } = lineageRail(["A", "B"], basedOn([]), new Set());

    expect(rows).toEqual(["A", "B"]);
    expect(meta.get("A")?.depth).toBe(0);
  });
});

describe("ancestry", () => {
  test("root first, the direction itself left out", () => {
    expect(ancestry("Lantern", CHAIN)).toEqual([
      "Meridian",
      "Dusk",
      "Sea",
      "Harbour",
      "Quay",
    ]);
  });

  test("a root has none", () => {
    expect(ancestry("Meridian", CHAIN)).toEqual([]);
  });

  test("a cycle ends where it started", () => {
    expect(
      ancestry(
        "A",
        basedOn([
          ["A", "B"],
          ["B", "A"],
        ]),
      ),
    ).toEqual(["B"]);
  });
});

describe("collapseChain", () => {
  test("a short chain shows whole", () => {
    expect(collapseChain(["Root", "Mid", "Parent"])).toEqual({
      head: ["Root", "Mid", "Parent"],
      hidden: [],
      tail: [],
    });
  });

  test("a long chain keeps its root and its parent", () => {
    expect(collapseChain(ancestry("Lantern", CHAIN))).toEqual({
      head: ["Meridian"],
      hidden: ["Dusk", "Sea", "Harbour"],
      tail: ["Quay"],
    });
  });
});

describe("tracedSegments", () => {
  const rail = lineageRail(SAVED_WITH_TIDE, CHAIN_WITH_TIDE, new Set());
  const lit = (target: string) => {
    const traced = tracedSegments(
      rail.rows,
      rail.meta,
      tracedTree(rail.parents, rail.children, target),
    );
    return Object.fromEntries([...traced].map(([title, set]) => [title, [...set].sort()]));
  };

  test("a fork child's line leaves its parent along the fork and runs through the rows between", () => {
    expect(lit("Tide")).toEqual({
      "Meridian": ["below", "mark"],
      Dusk: ["above", "below", "mark"],
      Sea: ["above", "below", "mark"],
      Harbour: ["above", "below", "mark"],
      Quay: ["above", "fork:2", "mark"],
      Lantern: ["through:2"],
      "Tide": ["above", "mark"],
    });
  });

  test("a root lights its whole family, every branch included", () => {
    expect(lit("Meridian")).toEqual({
      "Meridian": ["below", "mark"],
      Dusk: ["above", "below", "mark"],
      Sea: ["above", "below", "mark"],
      Harbour: ["above", "below", "fork:1", "mark"],
      Quay: ["above", "below", "fork:2", "mark", "through:1"],
      Lantern: ["above", "mark", "through:1", "through:2"],
      "Tide": ["above", "mark", "through:1"],
      Ferry: ["above", "mark"],
    });
  });

  test("a direction in the middle lights the line down to it and nothing past it", () => {
    expect(lit("Quay")).toEqual({
      "Meridian": ["below", "mark"],
      Dusk: ["above", "below", "mark"],
      Sea: ["above", "below", "mark"],
      Harbour: ["above", "below", "mark"],
      Quay: ["above", "mark"],
    });
  });

  test("a direction on no line at all lights only itself", () => {
    expect(lit("Current")).toEqual({ Current: ["mark"] });
  });

  test("a direction that is not on the rail lights nothing", () => {
    expect(lit("Nowhere")).toEqual({});
  });
});

describe("segmentsOf", () => {
  test("names every part a row draws", () => {
    expect(
      segmentsOf({
        title: "Quay",
        depth: 4,
        lane: 0,
        fromAbove: true,
        toBelow: true,
        forks: [2],
        through: [1],
      }),
    ).toEqual(["mark", "above", "below", "fork:2", "through:1"]);
  });
});

describe("reorderAmongSiblings", () => {
  const SHOWCASE_KIDS = ["Quay", "Ferry"];

  test("puts a sibling before the one it should precede", () => {
    const order = reorderAmongSiblings(SAVED, SAVED, "Ferry", "Quay", SHOWCASE_KIDS);

    expect(order.indexOf("Ferry")).toBe(order.indexOf("Quay") - 1);
    expect([...order].sort()).toEqual([...SAVED].sort());
  });

  test("with nothing to go before, lands after the last sibling", () => {
    const order = reorderAmongSiblings(SAVED, SAVED, "Quay", null, SHOWCASE_KIDS);

    expect(order.indexOf("Quay")).toBe(order.indexOf("Ferry") + 1);
  });

  test("moving a root moves it among the roots and leaves its family's rows alone", () => {
    const order = reorderAmongSiblings(SAVED, SAVED, "Meridian", "Current", [
      "Current",
      "Ledger",
      "Meridian",
    ]);
    const { rows } = lineageRail(order, CHAIN, new Set());

    expect(rows.slice(0, 3)).toEqual(["Meridian", "Dusk", "Sea"]);
    expect(rows.slice(-2)).toEqual(["Current", "Ledger"]);
  });

  test("an empty saved order starts from the config order", () => {
    const order = reorderAmongSiblings([], SAVED, "Ferry", "Quay", SHOWCASE_KIDS);

    expect(order.indexOf("Ferry")).toBe(order.indexOf("Quay") - 1);
  });
});

describe("tracedChain", () => {
  const rail = lineageRail(SAVED_WITH_TIDE, CHAIN_WITH_TIDE, new Set());

  test("runs from the family root down to the direction, root first", () => {
    expect(tracedChain(rail.parents, "Tide")).toEqual([
      "Meridian",
      "Dusk",
      "Sea",
      "Harbour",
      "Quay",
      "Tide",
    ]);
  });

  test("a root is a line of one", () => {
    expect(tracedChain(rail.parents, "Current")).toEqual(["Current"]);
  });
});

describe("trailPath", () => {
  test("a straight run is one line down the lane", () => {
    expect(
      trailPath([
        { x: 6, y: 10 },
        { x: 6, y: 60 },
      ]),
    ).toBe("M 6 10 L 6 60");
  });

  test("a step into another lane drops, turns out, turns down and arrives vertical", () => {
    expect(trailPath([{ x: 4, y: 10 }, { x: 14, y: 80 }])).toBe(
      "M 4 10 C 4 11.33, 4 12.67, 4 14 C 4 16.76, 6.24 19, 9 19 C 11.76 19, 14 21.24, 14 24 L 14 80",
    );
  });

  test("a fork with no room before the next mark goes straight there", () => {
    expect(trailPath([{ x: 6, y: 10 }, { x: 16, y: 16 }])).toBe("M 6 10 L 16 16");
  });

  test("room left around a forking mark is cut off the curve, not moved down it", () => {
    const whole = trailPath([{ x: 4, y: 10 }, { x: 14, y: 80 }]);
    const cut = trailPath([{ x: 4, y: 10, clear: 5 }, { x: 14, y: 80 }]);
    expect(whole.endsWith("14 24 L 14 80")).toBe(true);
    expect(cut.endsWith("14 24 L 14 80")).toBe(true);
    // Five pixels of arc: the four-pixel drop, then one pixel into the turn.
    const [, sx, sy] = cut.match(/^M ([\d.]+) ([\d.]+)/) as RegExpMatchArray;
    expect(Number(sx)).toBeGreaterThanOrEqual(4);
    expect(Number(sx)).toBeLessThan(4.3);
    expect(Number(sy)).toBeGreaterThan(14.9);
    expect(Number(sy)).toBeLessThan(15.1);
  });

  test("the light stops short of a mark that asks for room, and passes a tick that does not", () => {
    expect(
      trailPath([
        { x: 6, y: 10, clear: 5 },
        { x: 6, y: 60, clear: 0 },
        { x: 6, y: 110, clear: 8 },
      ]),
    ).toBe("M 6 15 L 6 60 M 6 60 L 6 102");
  });

  test("two marks with no room between them draw nothing", () => {
    expect(trailPath([{ x: 6, y: 10, clear: 5 }, { x: 6, y: 18, clear: 5 }])).toBe("");
  });

  test("nothing to draw is an empty path", () => {
    expect(trailPath([])).toBe("");
  });
});


describe("tracedTree", () => {
  const rail = lineageRail(SAVED_WITH_TIDE, CHAIN_WITH_TIDE, new Set());

  test("a leaf's lineage is the line back to its family root", () => {
    expect(tracedTree(rail.parents, rail.children, "Lantern")).toEqual({
      nodes: ["Meridian", "Dusk", "Sea", "Harbour", "Quay", "Lantern"],
      edges: [
        ["Meridian", "Dusk"],
        ["Dusk", "Sea"],
        ["Sea", "Harbour"],
        ["Harbour", "Quay"],
        ["Quay", "Lantern"],
      ],
    });
  });

  test("a root's lineage is its whole family, parents before children", () => {
    const { nodes, edges } = tracedTree(rail.parents, rail.children, "Meridian");

    expect(nodes).toEqual([
      "Meridian",
      "Dusk",
      "Sea",
      "Harbour",
      "Quay",
      "Lantern",
      "Tide",
      "Ferry",
    ]);
    expect(edges).toContainEqual(["Harbour", "Ferry"]);
    expect(edges).toContainEqual(["Quay", "Tide"]);
    expect(edges).toHaveLength(7);
  });

  test("a direction with no family is one node and no edges", () => {
    expect(tracedTree(rail.parents, rail.children, "Current")).toEqual({
      nodes: ["Current"],
      edges: [],
    });
  });
});
