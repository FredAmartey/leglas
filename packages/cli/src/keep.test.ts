import { describe, expect, test } from "vitest";

import { planKeep } from "./keep.js";
import type { Preview } from "@leglas/server";

const preview = (title: string, url: string, local = true): Preview & { local?: boolean } => {
  const entry: Preview & { local?: boolean } = { title, url, note: undefined, tags: [] };

  if (local) entry.local = true;

  return entry;
};

const previews = [
  preview("Current", "/?v-hero=current"),
  preview("Aurora", "/?v-hero=aurora"),
  preview("Dusk", "/?v-hero=dusk"),
];

describe("planKeep", () => {
  test("moves the winner into real source and ends that surface's exploration alone", () => {
    const plan = planKeep({
      title: "Aurora",
      previews: [...previews, preview("Compact", "/?v-nav=compact")],
      to: "src/components/hero.tsx",
    });

    if (!plan.ok) throw new Error(plan.error);
    // Out of the ignored directory, renamed to suit its new home.
    expect(plan.move).toEqual({
      from: ".leglas/variants/hero/aurora.tsx",
      to: "src/components/hero.tsx",
    });
    expect(plan.exportName).toBe("Hero");
    // The whole exploration goes, since nothing there was ever shared, and every
    // direction of the surface leaves the rail, the winner included. Other
    // surfaces are left alone.
    expect(plan.removeDir).toBe(".leglas/variants/hero");
    expect(plan.dropTitles.sort()).toEqual(["Aurora", "Current", "Dusk"]);
    // The one import change left to the user.
    expect(plan.instructions).toContain("src/components/hero.tsx");
    expect(plan.instructions).toContain("Hero");
  });

  test.each([
    ["a direction it cannot find", "Nope", previews, "src/hero.tsx", "Nope"],
    // Rather than guessing.
    [
      "a direction whose file it cannot locate",
      "Pricing v2",
      [preview("Pricing v2", "/pricing-v2")],
      "src/pricing.tsx",
      "cannot tell",
    ],
    // Which defeats the point.
    [
      "a destination inside the ignored directory",
      "Aurora",
      previews,
      ".leglas/variants/hero/keep.tsx",
      ".leglas",
    ],
    [
      "a destination that escapes the project",
      "Aurora",
      previews,
      "../elsewhere/hero.tsx",
      "inside the project",
    ],
    // runKeep makes a path inside the project relative first, so an absolute one
    // here is outside it, such as another drive on Windows.
    ["an absolute destination", "Aurora", previews, "/elsewhere/hero.tsx", "inside the project"],
  ])("refuses %s", (_case, title, among, to, said) => {
    const plan = planKeep({ title, previews: among, to });

    expect(plan.ok).toBe(false);
    expect(plan.ok ? "" : plan.error.toLowerCase()).toContain(said.toLowerCase());
  });
});
