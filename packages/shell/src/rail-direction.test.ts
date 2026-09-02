import { describe, expect, test } from "vitest";

import { railShape, resolveRailDirection } from "./rail-direction.js";

describe("resolveRailDirection", () => {
  test("reads the switch from the URL", () => {
    expect(resolveRailDirection("?v-rail=graph", false)).toBe("graph");
  });

  test("an unknown or missing value is the rail as it ships", () => {
    expect(resolveRailDirection("?v-rail=spiral", false)).toBe("current");
    expect(resolveRailDirection("", false)).toBe("current");
  });

  test("production never shows an unreleased rail", () => {
    expect(resolveRailDirection("?v-rail=graph", true)).toBe("current");
  });
});

describe("railShape", () => {
  test("the shipped rail is family order with one indent and nothing else", () => {
    expect(railShape("current")).toEqual({
      order: "family",
      indent: "one",
      crumbs: false,
      graph: false,
      live: false,
    });
  });

  test("only the trace rail answers the pointer", () => {
    expect(railShape("graph").live).toBe(false);
    expect(railShape("trace")).toMatchObject({ graph: true, crumbs: true, live: true });
  });

  test("the graph rail keeps the shipped indent and draws its lanes inside it", () => {
    expect(railShape("graph").indent).toBe("one");
    expect(railShape("graph").graph).toBe(true);
  });
});
