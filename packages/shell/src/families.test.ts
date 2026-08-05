import { describe, expect, test } from "vitest";

import { collapseRows, familyRows, rootOf } from "./families.js";

const basedOn = (pairs: [string, string][]) => new Map(pairs);

describe("familyRows", () => {
  test("children follow their direction, wherever the flat order put them", () => {
    // The exploration that motivated this: four directions, three variants of
    // one, registered in the order they were built.
    const rows = familyRows(
      ["Current", "Ledger", "Meridian", "Bulletin", "Meridian Dusk", "Meridian Sea"],
      basedOn([
        ["Meridian Dusk", "Meridian"],
        ["Meridian Sea", "Meridian"],
      ]),
    );

    expect(rows).toEqual([
      { title: "Current", depth: 0 },
      { title: "Ledger", depth: 0 },
      { title: "Meridian", depth: 0 },
      { title: "Meridian Dusk", depth: 1 },
      { title: "Meridian Sea", depth: 1 },
      { title: "Bulletin", depth: 0 },
    ]);
  });

  test("a variant whose direction is not in the list stands as a root", () => {
    // Hiding a direction must not strand its variants.
    const rows = familyRows(["Meridian Dusk"], basedOn([["Meridian Dusk", "Meridian"]]));

    expect(rows).toEqual([{ title: "Meridian Dusk", depth: 0 }]);
  });

  test("a variant of a variant displays under the family root", () => {
    const rows = familyRows(
      ["Meridian", "Meridian Dusk", "Meridian Dusk Ember"],
      basedOn([
        ["Meridian Dusk", "Meridian"],
        ["Meridian Dusk Ember", "Meridian Dusk"],
      ]),
    );

    expect(rows).toEqual([
      { title: "Meridian", depth: 0 },
      { title: "Meridian Dusk", depth: 1 },
      { title: "Meridian Dusk Ember", depth: 1 },
    ]);
  });

  test("previews with no basedOn behave exactly as before", () => {
    expect(familyRows(["A", "B"], basedOn([]))).toEqual([
      { title: "A", depth: 0 },
      { title: "B", depth: 0 },
    ]);
  });
});

describe("rootOf", () => {
  test("a cycle resolves instead of hanging", () => {
    const cyclic = basedOn([
      ["A", "B"],
      ["B", "A"],
    ]);

    expect(typeof rootOf("A", cyclic)).toBe("string");
  });

  test("a self-reference is its own root", () => {
    expect(rootOf("A", basedOn([["A", "A"]]))).toBe("A");
  });
});

describe("collapseRows", () => {
  const ROWS = [
    { title: "Meridian", depth: 0 },
    { title: "Meridian Dusk", depth: 1 },
    { title: "Bulletin", depth: 0 },
  ] as const;

  test("hides the children of a collapsed family, never the root", () => {
    expect(collapseRows(ROWS, new Set(["Meridian"]))).toEqual([
      { title: "Meridian", depth: 0 },
      { title: "Bulletin", depth: 0 },
    ]);
  });

  // A search revealing folded variants is the caller passing a set that does
  // not name their family, which is this case.
  test("nothing collapsed changes nothing", () => {
    expect(collapseRows(ROWS, new Set())).toEqual([...ROWS]);
  });
});
