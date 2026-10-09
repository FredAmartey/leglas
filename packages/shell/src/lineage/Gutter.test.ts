import { describe, expect, test } from "vitest";

import { railInsets } from "./Gutter.js";
import { lineageRail } from "./lineage.js";

const insetsFor = (titles: string[], pairs: [string, string][]) =>
  railInsets(lineageRail(titles, new Map(pairs), new Set()).meta);

describe("railInsets", () => {
  test("a rail with no families draws nothing, and one puts roots past the trunk", () => {
    // Every card fills its row.
    expect(insetsFor(["Meridian", "Ledger", "Dusk"], [])).toEqual({ root: 0, variant: 0 });
    // Roots past the trunk, variants past the first lanes.
    const family: [string, string][] = [["Ledger", "Meridian"]];
    expect(insetsFor(["Meridian", "Ledger", "Dusk"], family)).toEqual({ root: 16, variant: 32 });
    // A second sibling forks to the next lane, which a root's card already clears.
    expect(
      insetsFor(["Meridian", "Ledger", "Dusk", "Sea"], [...family, ["Dusk", "Meridian"]]),
    ).toEqual({ root: 16, variant: 32 });
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

  // A folded root keeps its mark, so its card still clears it, while its
  // family's lanes are gone. That's why the shell measures columns with every
  // family open, which Shell.test.tsx checks.
  test("a folded family takes its lanes off the rail, and its root still clears its mark", () => {
    const titles = ["Meridian", "Ledger", "Dusk", "Sea", "Harbour", "Quay"];

    const pairs: [string, string][] = [
      ["Ledger", "Meridian"],
      ["Dusk", "Meridian"],
      ["Sea", "Meridian"],
      ["Harbour", "Meridian"],
    ];

    const folded = railInsets(lineageRail(titles, new Map(pairs), new Set(["Meridian"])).meta);
    expect(folded).toEqual({ root: 16, variant: 0 });
  });
});
