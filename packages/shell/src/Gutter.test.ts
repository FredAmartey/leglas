import { describe, expect, test } from "vitest";

import { railInsets } from "./Gutter.js";
import { lineageRail } from "./lineage.js";

const insetsFor = (titles: string[], pairs: [string, string][]) =>
  railInsets(lineageRail(titles, new Map(pairs), new Set()).meta);

describe("railInsets", () => {
  test("a rail with no families draws nothing, so every card fills its row", () => {
    expect(insetsFor(["Meridian", "Ledger", "Dusk"], [])).toEqual({ root: 0, variant: 0 });
  });

  test("one family puts roots past the trunk and variants past the first lanes", () => {
    expect(insetsFor(["Meridian", "Ledger", "Dusk"], [["Ledger", "Meridian"]])).toEqual({ root: 16, variant: 32 });
  });

  test("two siblings fork to the next lane, which a root's card already clears", () => {
    expect(insetsFor(["Meridian", "Ledger", "Dusk", "Sea"], [["Ledger", "Meridian"], ["Dusk", "Meridian"]])).toEqual({
      root: 16,
      variant: 32,
    });
  });

  test("a root with four variants forks out to lane 3, and both columns move to clear it", () => {
    const pairs: [string, string][] = [
      ["Ledger", "Meridian"],
      ["Dusk", "Meridian"],
      ["Sea", "Meridian"],
      ["Harbour", "Meridian"],
    ];
    const insets = insetsFor(["Meridian", "Ledger", "Dusk", "Sea", "Harbour", "Quay"], pairs);
    // Lane 3 sits at 34px: the fork's knee needs 2px of dark, the ring 8px.
    expect(insets).toEqual({ root: 36, variant: 42 });
  });

  test("a lone root on a rail with a family elsewhere shares the roots' column", () => {
    const { root } = insetsFor(["Quay", "Meridian", "Ledger"], [["Ledger", "Meridian"]]);
    expect(root).toBe(16);
  });
});
