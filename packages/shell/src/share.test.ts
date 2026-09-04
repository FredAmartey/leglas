import { describe, expect, test } from "vitest";

import { DEFAULT_PREFS, loadPrefs, type Prefs } from "./prefs.js";
import {
  adoptLayout,
  directoryOf,
  expiryLine,
  grantLabel,
  observedRoutes,
  railShare,
  sameShare,
  scopeLine,
  shortLink,
  stageShare,
  unshareableReason,
  viewerPrefsRaw,
  totalViewers,
  viewersLine,
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

  test("adopting a pushed layout takes its fields and keeps the viewer's own", () => {
    const { request } = railShare({ ...prefs, hidden: [] }, previews);
    const mine: Prefs = { ...DEFAULT_PREFS, width: 300, font: "geist", collapsed: true, viewport: 390 };
    const adopted = adoptLayout(mine, request.layout, previews);
    expect(adopted.order).toEqual(["Wave", "Aurora", "Ember", "Old"]);
    expect(adopted.renames).toEqual({ Wave: "Tide" });
    expect(adopted.collapsedFamilies).toEqual(["Aurora"]);
    expect(adopted.viewport).toBe(834);
    expect(adopted.width).toBe(300);
    expect(adopted.font).toBe("geist");
    expect(adopted.collapsed).toBe(true);
  });
});

describe("observedRoutes", () => {
  const frameFor = (title: string, names: string[], readable = true): HTMLIFrameElement =>
    ({
      dataset: { preview: title },
      get contentWindow() {
        if (!readable) throw new Error("cross-origin");
        return {
          performance: { getEntriesByType: () => names.map((name) => ({ name })) },
        } as unknown as Window;
      },
    }) as unknown as HTMLIFrameElement;

  test("takes the paths a shared direction loaded, from this origin only", () => {
    const origin = "http://localhost:4100";
    const routes = observedRoutes(
      [
        frameFor("Table", [
          `${origin}/src/main.tsx`,
          `${origin}/@vite/client`,
          `${origin}/src/main.tsx`,
          "https://fonts.example.com/inter.woff2",
        ]),
        frameFor("Hidden", [`${origin}/not/shared.js`]),
      ],
      ["Table"],
      origin,
    );
    // Sorted, deduplicated, this origin only, and nothing from a direction
    // the share does not carry.
    expect(routes).toEqual(["/@vite/client", "/src/main.tsx"]);
  });

  test("a frame it cannot read costs nothing", () => {
    const origin = "http://localhost:4100";
    const routes = observedRoutes(
      [frameFor("Table", [], false), frameFor("Menu", [`${origin}/menu.js`])],
      ["Table", "Menu"],
      origin,
    );
    expect(routes).toEqual(["/menu.js"]);
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

  test("viewersLine counts sessions, never people", () => {
    expect(viewersLine(0)).toBe("nobody on it yet");
    expect(viewersLine(1)).toBe("1 watching");
    expect(viewersLine(4)).toBe("4 watching");
  });

  test("expiryLine reads in hours until the last hour, then minutes", () => {
    const now = 1_700_000_000_000;
    expect(expiryLine(now + 23 * 3_600_000, now)).toBe("23h left");
    expect(expiryLine(now + 90 * 60_000, now)).toBe("2h left");
    expect(expiryLine(now + 40 * 60_000, now)).toBe("40m left");
    // Never zero while it still works, and plain once it does not.
    expect(expiryLine(now + 20_000, now)).toBe("1m left");
    expect(expiryLine(now, now)).toBe("expired");
    expect(expiryLine(now - 5_000, now)).toBe("expired");
  });

  test("totalViewers counts across every link", () => {
    expect(totalViewers([])).toBe(0);
    expect(totalViewers([{ viewers: 0 }, { viewers: 0 }])).toBe(0);
    expect(totalViewers([{ viewers: 2 }, { viewers: 1 }, { viewers: 0 }])).toBe(3);
  });

  test("directoryOf offers the folder beside a refused path, never the root", () => {
    expect(directoryOf("/node_modules/.vite/deps/react.js")).toBe("/node_modules/.vite/deps/");
    expect(directoryOf("/assets/app.js")).toBe("/assets/");
    // A path at the root has no folder worth offering: it would be every
    // path there is.
    expect(directoryOf("/favicon.ico")).toBeNull();
    expect(directoryOf("/")).toBeNull();
  });

  test("grantLabel names an unnamed link by its place", () => {
    expect(grantLabel("Ana", 0)).toBe("Ana");
    expect(grantLabel("", 0)).toBe("Link 1");
    expect(grantLabel("   ", 2)).toBe("Link 3");
  });

  test("shortLink keeps the host and hides the token", () => {
    expect(shortLink("https://example-share.trycloudflare.com/leglas/s/abcdef123456")).toBe(
      "example-share.trycloudflare.com/leglas/s/…",
    );
    expect(shortLink("not a url")).toBe("not a url");
  });
});
