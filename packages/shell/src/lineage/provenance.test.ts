import { expect, test } from "vitest";

import { provenanceLine, provenanceOf } from "./provenance.js";

test("provenanceOf reports whichever origin a direction records, or nothing", () => {
  expect(provenanceOf({ basedOn: "Poster", askedFor: "make the pouch turn slower" })).toEqual({
    askedFor: "make the pouch turn slower",
    basedOn: "Poster",
  });
  // Either alone is worth showing: an ask alone is a change made in place.
  expect(provenanceOf({ basedOn: "Poster" })).toEqual({ askedFor: null, basedOn: "Poster" });
  expect(provenanceOf({ askedFor: "warmer" })).toEqual({ askedFor: "warmer", basedOn: null });
  // The words as they were typed, less the edges.
  expect(provenanceOf({ askedFor: "  the pouch looks fake  " })?.askedFor).toBe(
    "the pouch looks fake",
  );

  expect(provenanceOf({})).toBeNull();
  expect(provenanceOf(undefined)).toBeNull();
  expect(provenanceOf(null)).toBeNull();
  // A hand-edited config can hold an empty string, and an empty card is worse
  // than none.
  expect(provenanceOf({ askedFor: "   ", basedOn: "" })).toBeNull();
});

test("provenanceLine names the parent and the ask in one line, or stands on either alone", () => {
  expect(provenanceLine("Poster", "make the pouch turn slower")).toBe(
    "Variant of Poster · you asked for “make the pouch turn slower”",
  );
  expect(provenanceLine("Poster", null)).toBe("Variant of Poster");
  expect(provenanceLine(null, "warmer")).toBe("You asked for “warmer”");
  expect(provenanceLine(null, null)).toBeNull();
});
