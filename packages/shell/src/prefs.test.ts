import { describe, expect, test } from "vitest";

import { DEFAULT_W, MAX_W, MIN_W, loadPrefs, railOrder, reorder, type Prefs } from "./prefs.js";
import type { Preview } from "./types.js";

const previews: Preview[] = [
  { title: "Original", url: "/", tags: [] },
  { title: "Wave", url: "/?v-hero=wave", tags: ["Hero"] },
  { title: "Aurora", url: "/?v-hero=aurora", tags: ["Hero"] },
];

const stored = (prefs: Partial<Prefs>) => JSON.stringify(prefs);

describe("loadPrefs", () => {
  test("starts in config order when nothing is saved", () => {
    expect(loadPrefs(null, previews).order).toEqual(["Original", "Wave", "Aurora"]);
  });

  test("keeps a saved order", () => {
    const prefs = loadPrefs(stored({ order: ["Wave", "Aurora", "Original"] }), previews);

    expect(prefs.order).toEqual(["Wave", "Aurora", "Original"]);
  });

  test("appends previews the config has added since, rather than dropping them", () => {
    const prefs = loadPrefs(stored({ order: ["Aurora", "Original"] }), previews);

    expect(prefs.order).toEqual(["Aurora", "Original", "Wave"]);
  });

  test("forgets a preview the config no longer has", () => {
    const prefs = loadPrefs(
      stored({ order: ["Wave", "Deleted"], hidden: ["Deleted"], renames: { Deleted: "x" } }),
      previews,
    );

    expect(prefs.order).not.toContain("Deleted");
    expect(prefs.hidden).toEqual([]);
    expect(prefs.renames).toEqual({});
  });

  test("clamps a rail width that is out of range", () => {
    expect(loadPrefs(stored({ width: 10_000 }), previews).width).toBe(MAX_W);
    expect(loadPrefs(stored({ width: 1 }), previews).width).toBe(MIN_W);
  });

  test("falls back to a sane width when the saved one is not a number", () => {
    expect(loadPrefs(stored({ width: Number.NaN }), previews).width).toBe(DEFAULT_W);
  });

  test("ignores a viewport preset that no longer exists", () => {
    expect(loadPrefs(stored({ viewport: 1234 }), previews).viewport).toBeNull();
    expect(loadPrefs(stored({ viewport: 834 }), previews).viewport).toBe(834);
  });

  test("survives a corrupt store rather than refusing to start", () => {
    expect(loadPrefs("{not json", previews).order).toEqual(["Original", "Wave", "Aurora"]);
  });

  test("survives a store whose fields are the wrong shape", () => {
    const prefs = loadPrefs(stored({ hidden: "nope" as unknown as string[] }), previews);

    expect(prefs.hidden).toEqual([]);
  });
});

describe("reorder", () => {
  const base = loadPrefs(null, previews);

  test("moves a preview down to the requested slot", () => {
    expect(reorder(base, previews, "Original", 2)).toEqual(["Wave", "Aurora", "Original"]);
  });

  test("moves a preview up to the requested slot", () => {
    expect(reorder(base, previews, "Aurora", 0)).toEqual(["Aurora", "Original", "Wave"]);
  });

  test("moving to the end appends", () => {
    expect(reorder(base, previews, "Wave", 5)).toEqual(["Original", "Aurora", "Wave"]);
  });

  test("hidden previews keep their place in the underlying order", () => {
    const prefs = { ...base, hidden: ["Wave"] };

    // Visible rows are Original, Aurora; moving Aurora to slot 0 must not
    // reshuffle the hidden Wave out of the stored order.
    expect(reorder(prefs, previews, "Aurora", 0)).toContain("Wave");
  });
});

describe("railOrder", () => {
  test("no saved order means config order", () => {
    expect(railOrder([], ["A", "B"])).toEqual(["A", "B"]);
  });

  test("appends previews that arrived after the order was saved", () => {
    // An agent registers directions while the interface is open; a saved
    // order that predates them must not leave their rows invisible.
    expect(railOrder(["B", "A"], ["A", "B", "New"])).toEqual(["B", "A", "New"]);
  });

  test("drops titles that no longer exist", () => {
    expect(railOrder(["B", "Gone", "A"], ["A", "B"])).toEqual(["B", "A"]);
  });
});

describe("collapsedFamilies", () => {
  const previews: Preview[] = [
    { title: "Meridian", url: "/?v-hero=meridian", tags: [] },
    { title: "Meridian Dusk", url: "/?v-hero=meridian-dusk", tags: [] },
  ];

  test("survives a save and load round trip", () => {
    const saved = JSON.stringify({ collapsedFamilies: ["Meridian"] });
    expect(loadPrefs(saved, previews).collapsedFamilies).toEqual(["Meridian"]);
  });

  test("drops roots that no longer exist", () => {
    const saved = JSON.stringify({ collapsedFamilies: ["Gone"] });
    expect(loadPrefs(saved, previews).collapsedFamilies).toEqual([]);
  });

  test("defaults to nothing collapsed, including for pre-family saves", () => {
    expect(loadPrefs(JSON.stringify({ order: [] }), previews).collapsedFamilies).toEqual([]);
    expect(loadPrefs(null, previews).collapsedFamilies).toEqual([]);
  });
});
