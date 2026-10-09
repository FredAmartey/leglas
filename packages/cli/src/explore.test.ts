import { describe, expect, test } from "vitest";

import { planExplore } from "./explore.js";

describe("planExplore", () => {
  test("a new set must disagree, is decided before building, and registers as each lands", () => {
    const text = planExplore("hero", 5).instructions;

    expect(text).toContain("Build 5 design directions");
    expect(text).toContain(".leglas/variants/hero/");
    expect(text).toContain("npx leglas add");
    expect(text).toContain("/?v-hero=");
    expect(text).toContain("npx leglas new hero");
    // The goal and the collapse trap.
    expect(text.toLowerCase()).toContain("genuinely disagree");
    expect(text.toLowerCase()).toContain("before building");
    // Registered as each direction lands, not batched.
    expect(text).toContain("the moment it renders");
    expect(text).toContain("not the set at the end");
    expect(text).toContain('npx leglas show "<name>" --screenshot');
    expect(text).toContain("look before building the next one");
    // Spread directions are roots and carry no parent.
    expect(text).not.toContain("--based-on");
  });

  test("normalises the surface name the same way the scaffold does", () => {
    const plan = planExplore("Hero Backdrop", 2);

    expect(plan.slug).toBe("hero-backdrop");
    expect(plan.instructions).toContain("/?v-hero-backdrop=");
  });

  test("supplies no taste of its own", () => {
    // The prewritten style deck is retired; a named style here means the tool
    // is directing designs again.
    const text = planExplore("hero", 6).instructions.toLowerCase();

    for (const style of ["quiet", "editorial", "kinetic", "playful", "minimal", "brutalis"]) {
      expect(text).not.toContain(style);
    }
  });

  test("variants state the opposite goal and the drift trap, and register with their parent", () => {
    const plan = planExplore("hero", 4, "Aurora");

    expect(plan.basedOn).toBe("Aurora");
    expect(plan.instructions).toContain('variations of the "Aurora" direction');
    expect(plan.instructions.toLowerCase()).toContain("drift");
    expect(plan.instructions).toContain('--based-on "Aurora"');
    // The disagreement demand belongs to the other mode.
    expect(plan.instructions.toLowerCase()).not.toContain("genuinely disagree");
  });

  test("both modes share the same file mechanics", () => {
    const spread = planExplore("hero", 3).instructions;
    const variants = planExplore("hero", 3, "Aurora").instructions;

    const shared = spread.slice(
      spread.indexOf("Each one is its own file"),
      spread.indexOf("Register each"),
    );

    expect(variants).toContain(shared);
  });
});
