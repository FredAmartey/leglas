import { describe, expect, test } from "vitest";

import { ALL_BRIEFS, briefsFor, planBriefs } from "./briefs.js";

describe("ALL_BRIEFS", () => {
  test("every brief names an angle, says what to do, and says what not to do", () => {
    for (const brief of ALL_BRIEFS) {
      expect(brief.name).toBeTruthy();
      expect(brief.brief.length).toBeGreaterThan(60);
      expect(brief.avoid.length).toBeGreaterThan(20);
    }
  });

  test("names are unique, since they become preview titles", () => {
    const names = ALL_BRIEFS.map((brief) => brief.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("slugs are url-safe, since they become query values", () => {
    for (const brief of ALL_BRIEFS) {
      expect(brief.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("offers enough angles to be worth calling a set", () => {
    expect(ALL_BRIEFS.length).toBeGreaterThanOrEqual(8);
  });
});

describe("briefsFor", () => {
  test("returns the number asked for", () => {
    expect(briefsFor(3)).toHaveLength(3);
  });

  test("never returns the same angle twice", () => {
    const slugs = briefsFor(6).map((brief) => brief.slug);

    expect(new Set(slugs).size).toBe(6);
  });

  test("caps at the number of angles available rather than repeating", () => {
    expect(briefsFor(999)).toHaveLength(ALL_BRIEFS.length);
  });

  test("returns nothing for a nonsensical count", () => {
    expect(briefsFor(0)).toEqual([]);
    expect(briefsFor(-2)).toEqual([]);
  });

  test("the first three are the widest spread, not three neighbours", () => {
    // Ordering exists so a small request still explores. Quiet, image-led and
    // kinetic differ on composition, medium and motion rather than on colour.
    expect(briefsFor(3).map((brief) => brief.slug)).toEqual(["quiet", "image-led", "kinetic"]);
  });

  test("is deterministic, so the same request twice gives the same set", () => {
    expect(briefsFor(4)).toEqual(briefsFor(4));
  });
});

describe("planBriefs", () => {
  test("gives each direction a registration command ready to run", () => {
    const plan = planBriefs("hero", 2);

    expect(plan.previews[0]?.url).toBe("/?v-hero=quiet");
    expect(plan.commands[0]).toContain("leglas add");
    expect(plan.commands[0]).toContain("/?v-hero=quiet");
  });

  test("titles the direction by its angle", () => {
    expect(planBriefs("hero", 1).previews[0]?.title).toBe("Quiet");
  });

  test("normalises the surface name the same way the scaffold does", () => {
    expect(planBriefs("Hero Backdrop", 1).previews[0]?.url).toBe("/?v-hero-backdrop=quiet");
  });

  test("tells the agent where the files belong", () => {
    expect(planBriefs("hero", 1).instructions).toContain(".leglas/variants/hero/");
  });

  test("insists the directions stay distinct from each other", () => {
    const { instructions } = planBriefs("hero", 4);

    expect(instructions.toLowerCase()).toContain("distinct");
  });
});
