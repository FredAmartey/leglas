import { describe, expect, test } from "vitest";

import {
  DEFAULT_W,
  MAX_W,
  MIN_W,
  deleteDirections,
  loadPrefs,
  railOrder,
  type Prefs,
} from "./prefs.js";
import type { Preview } from "./types.js";

const previews: Preview[] = [
  { title: "Original", url: "/", tags: [] },
  { title: "Wave", url: "/?v-hero=wave", tags: ["Hero"] },
  { title: "Aurora", url: "/?v-hero=aurora", tags: ["Hero"] },
];

const stored = (prefs: Partial<Prefs>) => JSON.stringify(prefs);

describe("loadPrefs", () => {
  test("starts in config order with nothing folded when nothing is saved", () => {
    expect(loadPrefs(null, previews).order).toEqual(["Original", "Wave", "Aurora"]);
    expect(loadPrefs(null, previews).collapsedFamilies).toEqual([]);
    // Nor in a save from before families.
    expect(loadPrefs(stored({ order: [] }), previews).collapsedFamilies).toEqual([]);
  });

  test("keeps a saved order, appending previews the config has added since", () => {
    const prefs = loadPrefs(stored({ order: ["Aurora", "Original"] }), previews);

    expect(prefs.order).toEqual(["Aurora", "Original", "Wave"]);
  });

  test("forgets a preview the config no longer has, and keeps what is still there", () => {
    const prefs = loadPrefs(
      stored({
        order: ["Wave", "Deleted"],
        hidden: ["Deleted"],
        renames: { Deleted: "x" },
        collapsedFamilies: ["Wave", "Deleted"],
      }),
      previews,
    );

    expect(prefs.order).not.toContain("Deleted");
    expect(prefs.hidden).toEqual([]);
    expect(prefs.renames).toEqual({});
    expect(prefs.collapsedFamilies).toEqual(["Wave"]);
  });

  test("keeps permanently deleted directions out of the rail", () => {
    const prefs = loadPrefs(
      stored({
        deleted: ["Wave"],
        hidden: ["Wave", "Aurora"],
        order: ["Original", "Wave", "Aurora"],
        renames: { Wave: "Foam", Aurora: "Glow" },
      }),
      previews,
    );

    expect(prefs.deleted).toEqual(["Wave"]);
    expect(prefs.order).toEqual(["Original", "Aurora"]);
    expect(prefs.hidden).toEqual(["Aurora"]);
    expect(prefs.renames).toEqual({ Aurora: "Glow" });
  });

  test("clamps a rail width that is out of range, and falls back when it is not a number", () => {
    expect(loadPrefs(stored({ width: 10_000 }), previews).width).toBe(MAX_W);
    expect(loadPrefs(stored({ width: 1 }), previews).width).toBe(MIN_W);
    expect(loadPrefs(stored({ width: Number.NaN }), previews).width).toBe(DEFAULT_W);
  });

  test("ignores a viewport preset that no longer exists", () => {
    expect(loadPrefs(stored({ viewport: 1234 }), previews).viewport).toBeNull();
    expect(loadPrefs(stored({ viewport: 834 }), previews).viewport).toBe(834);
  });

  test("shows the app's dev overlays and the tools widget, and builds nothing, until asked", () => {
    // The badge belongs to the user's app; hiding it unasked makes the preview
    // differ from their dev server.
    expect(loadPrefs(null, previews).showDevOverlays).toBe(true);
    expect(loadPrefs(stored({ showDevOverlays: false }), previews).showDevOverlays).toBe(false);
    expect(loadPrefs(null, previews).showWidget).toBe(true);
    expect(loadPrefs(stored({ showWidget: false }), previews).showWidget).toBe(false);
    expect(loadPrefs(null, previews).buildDirections).toBe(false);
    expect(loadPrefs(stored({ buildDirections: true }), previews).buildDirections).toBe(true);
    expect(loadPrefs(JSON.stringify({ buildDirections: "yes" }), previews).buildDirections).toBe(
      false,
    );
  });

  test("survives a corrupt store rather than refusing to start", () => {
    expect(loadPrefs("{not json", previews).order).toEqual(["Original", "Wave", "Aurora"]);
  });

  test("survives a store whose fields are the wrong shape", () => {
    const prefs = loadPrefs(JSON.stringify({ hidden: "nope" }), previews);

    expect(prefs.hidden).toEqual([]);
  });
});

describe("deleteDirections", () => {
  test("removes directions and all of their saved rail state", () => {
    const prefs: Prefs = {
      ...loadPrefs(null, previews),
      collapsedFamilies: ["Wave"],
      hidden: ["Wave", "Aurora"],
      renames: { Wave: "Foam", Aurora: "Glow" },
    };

    const deleted = deleteDirections(prefs, ["Wave"]);

    expect(deleted.deleted).toEqual(["Wave"]);
    expect(deleted.hidden).toEqual(["Aurora"]);
    expect(deleted.order).toEqual(["Original", "Aurora"]);
    expect(deleted.renames).toEqual({ Aurora: "Glow" });
    expect(deleted.collapsedFamilies).toEqual([]);
  });

  test("deleting the same direction twice does not duplicate its tombstone", () => {
    const once = deleteDirections(loadPrefs(null, previews), ["Wave"]);

    expect(deleteDirections(once, ["Wave"]).deleted).toEqual(["Wave"]);
  });
});

test("railOrder keeps the saved order, drops titles gone since and appends new ones", () => {
  expect(railOrder([], ["A", "B"])).toEqual(["A", "B"]);
  // An agent registers directions while the interface is open; a saved order
  // from before must not hide their rows.
  expect(railOrder(["B", "A"], ["A", "B", "New"])).toEqual(["B", "A", "New"]);
  expect(railOrder(["B", "Gone", "A"], ["A", "B"])).toEqual(["B", "A"]);
});
