import { describe, expect, test } from "vitest";

import { provenanceLine, provenanceOf } from "./provenance.js";

describe("provenanceOf", () => {
  test("reports both facts when a variant carries them", () => {
    expect(provenanceOf({ basedOn: "Poster", askedFor: "make the pouch turn slower" })).toEqual({
      askedFor: "make the pouch turn slower",
      basedOn: "Poster",
    });
  });

  test("says nothing about a direction that records neither", () => {
    expect(provenanceOf({})).toBeNull();
    expect(provenanceOf(undefined)).toBeNull();
    expect(provenanceOf(null)).toBeNull();
  });

  test("a parent alone is worth showing", () => {
    expect(provenanceOf({ basedOn: "Poster" })).toEqual({ askedFor: null, basedOn: "Poster" });
  });

  test("an ask alone is worth showing, for a change made in place", () => {
    expect(provenanceOf({ askedFor: "warmer" })).toEqual({ askedFor: "warmer", basedOn: null });
  });

  // A hand-edited config can hold an empty string where a value should be, and
  // an empty card is worse than no card.
  test("blank values count as absent", () => {
    expect(provenanceOf({ askedFor: "   ", basedOn: "" })).toBeNull();
  });

  test("keeps the words as they were typed, less the edges", () => {
    expect(provenanceOf({ askedFor: "  the pouch looks fake  " })?.askedFor).toBe(
      "the pouch looks fake",
    );
  });
});

describe("provenanceLine", () => {
  test("names the parent and the ask in one line", () => {
    expect(provenanceLine("Poster", "make the pouch turn slower")).toBe(
      "Variant of Poster · you asked for “make the pouch turn slower”",
    );
  });

  test("stands on the parent alone", () => {
    expect(provenanceLine("Poster", null)).toBe("Variant of Poster");
  });

  test("stands on the ask alone", () => {
    expect(provenanceLine(null, "warmer")).toBe("You asked for “warmer”");
  });

  test("has nothing to say about a direction with no origin", () => {
    expect(provenanceLine(null, null)).toBeNull();
  });
});
