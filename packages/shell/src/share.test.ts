import { describe, expect, test } from "vitest";

import { DEFAULT_PREFS, loadPrefs, type Prefs } from "./prefs.js";
import {
  railShare,
  sameShare,
  scopeLine,
  shortLink,
  stageShare,
  unshareableReason,
  viewerPrefsRaw,
} from "./share.js";
import type { Preview } from "./types.js";

const previews: Preview[] = [
  { title: "Aurora", url: "/?v=aurora", tags: [] },
  { title: "Ember", url: "/?v=ember", tags: [], basedOn: "Aurora" },
  { title: "Wave", url: "/?v=wave", tags: [] },
  { title: "Old", url: "/", tags: [], branch: "release" },
];

const prefs: Prefs = {
  ...DEFAULT_PREFS,
  order: ["Wave", "Aurora", "Ember", "Old"],
  renames: { Wave: "Tide", Old: "Last week" },
  hidden: ["Wave"],
  collapsedFamilies: ["Aurora"],
  viewport: 834,
};

describe("railShare", () => {
  test("carries what is showing, in rail order, and names what cannot go", () => {
    const { request, leftOut } = railShare(prefs, previews);
    expect(request.scope).toBe("rail");
    expect(request.titles).toEqual(["Aurora", "Ember"]);
    expect(leftOut).toEqual(["Old"]);
    expect(request.layout).toEqual({
      order: ["Aurora", "Ember"],
      renames: {},
      hidden: [],
      collapsedFamilies: ["Aurora"],
      compare: null,
      viewport: 834,
    });
  });

  test("keeps a rename only for a direction that goes", () => {
    const { request } = railShare({ ...prefs, hidden: [] }, previews);
    expect(request.titles).toEqual(["Wave", "Aurora", "Ember"]);
    expect(request.layout.renames).toEqual({ Wave: "Tide" });
  });

  test("a rail with no saved order shares config order", () => {
    const { request } = railShare(DEFAULT_PREFS, previews);
    expect(request.titles).toEqual(["Aurora", "Ember", "Wave"]);
  });
});

describe("stageShare", () => {
  test("one direction on stage is a direction share", () => {
    const { request, reason } = stageShare(prefs, previews, "Ember", null);
    expect(reason).toBeNull();
    expect(request?.scope).toBe("direction");
    expect(request?.titles).toEqual(["Ember"]);
    expect(request?.layout.compare).toBeNull();
    expect(request?.layout.collapsedFamilies).toEqual([]);
  });

  test("a split stage is a compare share with the pair set", () => {
    const { request } = stageShare(prefs, previews, "Aurora", "Ember");
    expect(request?.scope).toBe("compare");
    expect(request?.titles).toEqual(["Aurora", "Ember"]);
    expect(request?.layout.compare).toBe("Ember");
  });

  test("refuses a pair with a branch on one side, naming it as the rail does", () => {
    const { request, reason } = stageShare(prefs, previews, "Aurora", "Old");
    expect(request).toBeNull();
    expect(reason).toBe("Last week runs on its own port and can't be shared yet");
  });

  test("an empty stage has nothing to share", () => {
    expect(stageShare(prefs, previews, "", null).reason).toBe("Nothing is on stage yet");
  });
});

describe("unshareableReason", () => {
  test("a branch preview cannot go; a route can", () => {
    expect(unshareableReason(previews[3])).toMatch(/own port/);
    expect(unshareableReason(previews[0])).toBeNull();
    expect(unshareableReason(undefined)).toBe("is not on the rail");
  });
});

describe("sameShare", () => {
  test("is blind to rename and fold order, and to nothing else", () => {
    const a = railShare(prefs, previews).request;
    const b = railShare({ ...prefs, collapsedFamilies: ["Aurora"] }, previews).request;
    expect(sameShare(a, b)).toBe(true);
    expect(sameShare(a, { ...a, layout: { ...a.layout, viewport: null } })).toBe(false);
    expect(sameShare(a, { ...a, titles: ["Ember", "Aurora"] })).toBe(false);
    expect(sameShare(a, { ...a, scope: "direction" })).toBe(false);
    expect(
      sameShare(a, { ...a, layout: { ...a.layout, renames: { Aurora: "Dawn" } } }),
    ).toBe(false);
  });
});

describe("viewerPrefsRaw", () => {
  test("seeds a viewer's rail through the same validation as a saved one", () => {
    const { request } = railShare({ ...prefs, hidden: [] }, previews);
    const seeded = loadPrefs(viewerPrefsRaw(request.layout), previews);
    expect(seeded.order).toEqual(["Wave", "Aurora", "Ember", "Old"]);
    expect(seeded.renames).toEqual({ Wave: "Tide" });
    expect(seeded.collapsedFamilies).toEqual(["Aurora"]);
    expect(seeded.viewport).toBe(834);
    expect(seeded.hidden).toEqual([]);
  });
});

describe("words", () => {
  test("scopeLine says the rail with its count, or names the pair", () => {
    const name = (title: string) => (title === "Wave" ? "Tide" : title);
    expect(scopeLine("rail", ["Aurora", "Ember"], name)).toBe("The whole rail · 2 directions");
    expect(scopeLine("rail", ["Aurora"], name)).toBe("The whole rail · 1 direction");
    expect(scopeLine("compare", ["Aurora", "Wave"], name)).toBe("Aurora + Tide");
    expect(scopeLine("direction", ["Wave"], name)).toBe("Tide");
  });

  test("shortLink keeps the host and hides the token", () => {
    expect(shortLink("https://example-share.trycloudflare.com/leglas/s/abcdef123456")).toBe(
      "example-share.trycloudflare.com/leglas/s/…",
    );
    expect(shortLink("not a url")).toBe("not a url");
  });
});
