import { describe, expect, test } from "vitest";

import { renderedSignature, twinsOf } from "./rendered.js";

describe("renderedSignature", () => {
  test("two pages drawing the same thing agree", () => {
    const a = renderedSignature("Ship design faster\nGet started", ["SECTION", "H1", "BUTTON"]);
    const b = renderedSignature("Ship design faster\nGet started", ["SECTION", "H1", "BUTTON"]);

    expect(a).toBe(b);
  });

  test("different words disagree", () => {
    const a = renderedSignature("Ship design faster", ["H1"]);
    const b = renderedSignature("Choose well", ["H1"]);

    expect(a).not.toBe(b);
  });

  test("the same words in a different structure disagree", () => {
    // Two directions can say the same thing and look nothing alike, which is
    // the whole point of comparing them.
    const a = renderedSignature("Ship design faster", ["SECTION", "H1"]);
    const b = renderedSignature("Ship design faster", ["ARTICLE", "FIGURE", "H1"]);

    expect(a).not.toBe(b);
  });

  test("ignores whitespace, which reflows without changing the design", () => {
    const a = renderedSignature("Ship design   faster\n\n  Get started", ["H1"]);
    const b = renderedSignature("Ship design faster\nGet started", ["H1"]);

    expect(a).toBe(b);
  });

  test("ignores case, since a text-transform is styling not content", () => {
    expect(renderedSignature("SHIP DESIGN", ["H1"])).toBe(renderedSignature("Ship design", ["H1"]));
  });

  test("says nothing about a page that drew nothing yet", () => {
    expect(renderedSignature("", [])).toBeNull();
    expect(renderedSignature("   ", ["DIV"])).toBeNull();
  });

  test("treats a bare app shell as nothing drawn", () => {
    // A single-page app before hydration: a root div and no text. Comparing
    // these would call every direction identical.
    expect(renderedSignature("", ["DIV", "SCRIPT"])).toBeNull();
  });
});

describe("twinsOf", () => {
  test("pairs previews that drew the same page", () => {
    const twins = twinsOf({ Original: "sig-a", Typo: "sig-a", Other: "sig-b" });

    expect(twins["Original"]).toEqual(["Typo"]);
    expect(twins["Typo"]).toEqual(["Original"]);
  });

  test("says nothing about a preview that is unique", () => {
    const twins = twinsOf({ Original: "sig-a", Other: "sig-b" });

    expect(twins["Other"]).toBeUndefined();
  });

  test("groups three that all match", () => {
    const twins = twinsOf({ A: "same", B: "same", C: "same" });

    expect(twins["A"]?.sort()).toEqual(["B", "C"]);
  });

  test("ignores previews that have not drawn yet", () => {
    const twins = twinsOf({ A: null, B: null, C: "sig" });

    expect(twins).toEqual({});
  });

  test("returns nothing when every preview differs", () => {
    expect(twinsOf({ A: "one", B: "two" })).toEqual({});
  });
});
