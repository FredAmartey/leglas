import { describe, expect, test } from "vitest";

import { planExplore } from "./explore.js";

describe("planExplore", () => {
  test("tells the agent where the files belong and how to register", () => {
    const plan = planExplore("hero", 4);

    expect(plan.instructions).toContain(".leglas/variants/hero/");
    expect(plan.instructions).toContain("leglas add");
    expect(plan.instructions).toContain("/?v-hero=");
    expect(plan.instructions).toContain("leglas new hero");
  });

  test("normalises the surface name the same way the scaffold does", () => {
    const plan = planExplore("Hero Backdrop", 2);

    expect(plan.slug).toBe("hero-backdrop");
    expect(plan.instructions).toContain("/?v-hero-backdrop=");
  });

  test("asks for the number of directions requested", () => {
    expect(planExplore("hero", 5).instructions).toContain("Build 5 design directions");
  });

  test("supplies no taste of its own", () => {
    // The prewritten deck is retired. If a named style ever shows up in the
    // instructions again, the tool has gone back to directing designs.
    const text = planExplore("hero", 6).instructions.toLowerCase();
    for (const style of ["quiet", "editorial", "kinetic", "playful", "minimal", "brutalis"]) {
      expect(text).not.toContain(style);
    }
  });

  test("exploring states the goal and the collapse trap", () => {
    const text = planExplore("hero", 6).instructions.toLowerCase();

    expect(text).toContain("genuinely disagree");
    expect(text).toContain("before building");
  });

  test("shades state the opposite goal and the drift trap", () => {
    const plan = planExplore("hero", 4, "Aurora");

    expect(plan.basedOn).toBe("Aurora");
    expect(plan.instructions).toContain('variations of the "Aurora" direction');
    expect(plan.instructions.toLowerCase()).toContain("drift");
    // The disagreement demand belongs to the other mode.
    expect(plan.instructions.toLowerCase()).not.toContain("genuinely disagree");
  });

  test("both modes share the same registration mechanics", () => {
    const spread = planExplore("hero", 3).instructions;
    const shades = planExplore("hero", 3, "Aurora").instructions;
    const mechanics = spread.slice(spread.indexOf("Each one is its own file"));

    expect(shades).toContain(mechanics);
  });
});
