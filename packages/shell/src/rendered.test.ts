import { describe, expect, test } from "vitest";

import { paintSample, renderedSignature, twinsOf } from "./rendered.js";

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

describe("paint in the signature", () => {
  const TEXT = "Every incident, one timeline. Start free";
  const TAGS = ["MAIN", "DIV", "H1", "P", "BUTTON"];

  test("colour shades of one direction are different pages", () => {
    // Four deliberate shades share every word and every element; only the
    // painted field differs. Calling them duplicates told the user their
    // shade set was a mistake.
    const dawn = renderedSignature(TEXT, TAGS, ["rgba(0,0,0,0);linear-gradient(#0E1B3A,#F2A65A);#fff"]);
    const dusk = renderedSignature(TEXT, TAGS, ["rgba(0,0,0,0);linear-gradient(#0B1026,#E0623A);#fff"]);

    expect(dawn).not.toBeNull();
    expect(dawn).not.toBe(dusk);
  });

  test("an accidental duplicate still matches, paint included", () => {
    // A typo'd query value serves the same page, which renders the same
    // colours along with the same words.
    const paint = ["rgb(255,255,255);none;rgb(17,17,17)"];
    expect(renderedSignature(TEXT, TAGS, paint)).toBe(renderedSignature(TEXT, TAGS, paint));
  });

  test("no paint sample behaves as before", () => {
    expect(renderedSignature(TEXT, TAGS)).toBe(renderedSignature(TEXT, TAGS, []));
  });
});

describe("paintSample", () => {
  type Node = {
    children: Node[];
    tagName: string;
    paint: { backgroundColor: string; backgroundImage: string; color: string };
  };
  const node = (bg: string, children: Node[] = [], tagName = "DIV"): Node => ({
    children,
    tagName,
    paint: { backgroundColor: bg, backgroundImage: "none", color: "#111" },
  });
  const styleOf = (element: unknown) => (element as Node).paint;

  test("a script beside the root is not a branch", () => {
    // Vite injects its module script into body, so body has two element
    // children in every app it serves. Counting the script stopped the
    // descent at the body, whose colour is the same for every direction,
    // which put the shade collision right back.
    const body = node("transparent", [
      node("", [], "SCRIPT"),
      node("transparent", [node("#0E1B3A")]),
    ]);

    const samples = paintSample(body, styleOf);

    expect(samples[2]).toContain("#0E1B3A");
  });

  test("descends single-child wrappers to find the page surface", () => {
    // body > #root > main: the gradient sits on main, two levels down.
    const body = node("transparent", [node("transparent", [node("#0E1B3A")])]);

    const samples = paintSample(body, styleOf);

    expect(samples).toHaveLength(3);
    expect(samples[2]).toContain("#0E1B3A");
  });

  test("stops where the tree branches, since the surface is above the content", () => {
    const body = node("#fff", [node("#eee", [node("a"), node("b")])]);

    expect(paintSample(body, styleOf)).toHaveLength(2);
  });

  test("caps the descent so a deep chain stays cheap", () => {
    let tree = node("#0");
    for (let depth = 0; depth < 20; depth += 1) tree = node(`#${depth}`, [tree]);

    expect(paintSample(tree, styleOf).length).toBeLessThanOrEqual(4);
  });

  test("returns nothing for a missing body", () => {
    expect(paintSample(null, styleOf)).toEqual([]);
  });
});
