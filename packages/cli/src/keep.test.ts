import { describe, expect, test } from "vitest";

import { planKeep } from "./keep.js";
import type { Preview } from "@leglas/server";

const preview = (title: string, url: string, local = true): Preview & { local?: boolean } => ({
  title,
  url,
  note: undefined,
  tags: [],
  ...(local ? { local: true } : {}),
});

const previews = [
  preview("Current", "/?v-hero=current"),
  preview("Aurora", "/?v-hero=aurora"),
  preview("Dusk", "/?v-hero=dusk"),
];

describe("planKeep", () => {
  test("moves the winner out of the ignored directory into real source", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "src/components/hero.tsx" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.move).toEqual({
      from: ".leglas/variants/hero/aurora.tsx",
      to: "src/components/hero.tsx",
    });
  });

  test("deletes the whole exploration, since nothing there was ever shared", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "src/components/hero.tsx" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.removeDir).toBe(".leglas/variants/hero");
  });

  test("drops every direction of that surface from the rail, winner included", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "src/components/hero.tsx" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.dropTitles.sort()).toEqual(["Aurora", "Current", "Dusk"]);
  });

  test("leaves directions belonging to other surfaces alone", () => {
    const plan = planKeep({
      title: "Aurora",
      previews: [...previews, preview("Compact", "/?v-nav=compact")],
      to: "src/components/hero.tsx",
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.dropTitles).not.toContain("Compact");
  });

  test("renames the exported component to suit its new home", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "src/components/hero.tsx" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.exportName).toBe("Hero");
  });

  test("tells the user the one import change left to them", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "src/components/hero.tsx" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.instructions).toContain("src/components/hero.tsx");
    expect(plan.instructions).toContain("Hero");
  });

  test("refuses a direction it cannot find", () => {
    const plan = planKeep({ title: "Nope", previews, to: "src/hero.tsx" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("Nope");
  });

  test("refuses a direction whose file it cannot locate, rather than guessing", () => {
    const plan = planKeep({
      title: "Pricing v2",
      previews: [preview("Pricing v2", "/pricing-v2")],
      to: "src/pricing.tsx",
    });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.toLowerCase()).toContain("cannot tell");
  });

  test("refuses a destination inside the ignored directory, which defeats the point", () => {
    const plan = planKeep({ title: "Aurora", previews, to: ".leglas/variants/hero/keep.tsx" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain(".leglas");
  });

  test("refuses a destination that escapes the project", () => {
    const plan = planKeep({ title: "Aurora", previews, to: "../elsewhere/hero.tsx" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.toLowerCase()).toContain("inside the project");
  });
});
