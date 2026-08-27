import { describe, expect, test } from "vitest";

import {
  paintSample,
  quantiseCssPixel,
  renderedSignature,
  twinsOf,
  visualSample,
} from "./rendered.js";

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

  test("colour variants of one direction are different pages", () => {
    // Four deliberate variants share every word and every element; only the
    // painted field differs. Calling them duplicates told the user their
    // variant set was a mistake.
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

  test("the same copy and paint in a different layout is not a duplicate", () => {
    const sharedPaint = ["rgb(13,13,13);none;rgb(240,240,240)"];
    const capsule = renderedSignature(TEXT, TAGS, sharedPaint, ["NAV{rect:120,20,650,64;display:grid}"]);
    const satellite = renderedSignature(TEXT, TAGS, sharedPaint, ["NAV{rect:940,20,260,340;display:block}"]);

    expect(capsule).not.toBe(satellite);
  });

  test("identical high-fidelity visual records still agree", () => {
    const visual = ["SVG{rect:20,20,64,64;d:M0 0L64 64}", "NAV{rect:120,20,650,64;display:grid}"];
    expect(renderedSignature(TEXT, TAGS, [], visual)).toBe(renderedSignature(TEXT, TAGS, [], visual));
  });

  test("pseudo-elements, vector geometry and media sources affect the verdict", () => {
    const base = renderedSignature(TEXT, TAGS, [], ["BODY{::before{content:'';width:10px}}", "PATH{d:M0 0L1 1}", "IMG{src:a.webp}"]);
    const changed = renderedSignature(TEXT, TAGS, [], ["BODY{::before{content:'';width:20px}}", "PATH{d:M0 0L2 2}", "IMG{src:b.webp}"]);

    expect(base).not.toBe(changed);
  });
});

describe("visualSample", () => {
  type FakeElement = {
    getAttribute: (name: string) => string | null;
    getBoundingClientRect: () => { bottom: number; height: number; left: number; right: number; top: number; width: number };
    matches: () => boolean;
    closest: () => null;
    ownerDocument: { defaultView: { getComputedStyle: () => { position: string }; scrollX: number; scrollY: number } };
    parentElement: FakeElement | null;
    querySelectorAll: () => FakeElement[];
    tagName: string;
  };

  const fakeTree = (childLeft: number, path = "M0 0L10 10") => {
    const ownerDocument = {
      defaultView: { getComputedStyle: () => ({ position: "static" }), scrollX: 0, scrollY: 0 },
    };
    const rect = (left: number, width: number) => ({ bottom: 40, height: 20, left, right: left + width, top: 20, width });
    const child: FakeElement = {
      getAttribute: (name) => name === "d" ? path : null,
      getBoundingClientRect: () => rect(childLeft, 100),
      matches: () => false,
      closest: () => null,
      ownerDocument,
      parentElement: null,
      querySelectorAll: () => [],
      tagName: "PATH",
    };
    const body: FakeElement = {
      getAttribute: () => null,
      getBoundingClientRect: () => rect(0, 1280),
      matches: () => false,
      closest: () => null,
      ownerDocument,
      parentElement: null,
      querySelectorAll: () => [child],
      tagName: "BODY",
    };
    child.parentElement = body;
    return body as unknown as HTMLElement;
  };

  const styleOf = (_element: Element, pseudo?: string) => ({
    getPropertyValue: (property: string) => {
      if (property === "content") return pseudo ? "none" : "";
      if (property === "animation-name") return "none";
      if (property === "display") return "block";
      return "";
    },
  });

  test("captures geometry that text-and-tag comparison misses", () => {
    expect(visualSample(fakeTree(20), styleOf)).not.toEqual(visualSample(fakeTree(220), styleOf));
  });

  test("captures vector path changes", () => {
    expect(visualSample(fakeTree(20, "M0 0L10 10"), styleOf)).not.toEqual(
      visualSample(fakeTree(20, "M0 0L20 20"), styleOf),
    );
  });

  test("half-pixel quantisation ignores sub-raster noise", () => {
    expect(quantiseCssPixel(10.01)).toBe(quantiseCssPixel(10.19));
    expect(quantiseCssPixel(10.01)).not.toBe(quantiseCssPixel(10.49));
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
    // which put the variant collision right back.
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

describe("signature size", () => {
  test("the signature is a digest, not the sample it was read from", () => {
    // A visual sample runs to hundreds of elements at a couple of kilobytes
    // each, and one used to be kept per direction for the life of the page.
    const visual = Array.from(
      { length: 720 },
      (_, index) => `DIV{rect:${index},${index * 2},1280,64;${"display:block;".repeat(120)}}`,
    );
    const read = () =>
      renderedSignature(
        "Every incident, one timeline. Start free",
        ["MAIN", "DIV"],
        ["rgb(0,0,0);none;rgb(255,255,255)"],
        visual,
      );

    expect(read()).not.toBeNull();
    expect((read() ?? "").length).toBeLessThan(40);
    expect(read()).toBe(read());
  });
});
