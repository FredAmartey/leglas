import { describe, expect, test } from "vitest";

import { anchorFor, elementText, selectorFor, type ElementLike, type Rect } from "./anchor.js";

type Spec = { tag: string; id?: string; className?: string; text?: string; children?: Spec[] };

/** A tree the selector walk can climb, shaped like the DOM's own. */
function tree(spec: Spec): ElementLike {
  const node: ElementLike = {
    children: [],
    className: spec.className,
    id: spec.id ?? null,
    parentElement: null,
    tagName: spec.tag.toUpperCase(),
    textContent: spec.text ?? null,
  };

  const children = (spec.children ?? []).map((child) => tree(child));

  for (const child of children) child.parentElement = node;
  node.children = children;

  return node;
}

const find = (root: ElementLike, tag: string, nth = 1): ElementLike => {
  let seen = 0;

  const walk = (node: ElementLike): ElementLike | null => {
    if (node.tagName === tag.toUpperCase()) {
      seen += 1;

      if (seen === nth) return node;
    }

    for (const child of Array.from(node.children)) {
      const hit = walk(child);

      if (hit) return hit;
    }

    return null;
  };

  const found = walk(root);

  if (!found) throw new Error(`no ${tag} in the tree`);

  return found;
};

describe("selectorFor", () => {
  test("walks up to the body, numbering by type", () => {
    const root = tree({
      children: [
        { children: [{ tag: "p" }, { tag: "p" }], tag: "section" },
        { children: [{ tag: "p" }], tag: "section" },
      ],
      tag: "body",
    });

    expect(selectorFor(find(root, "p", 3))).toBe("section:nth-of-type(2) > p:nth-of-type(1)");
  });

  // The edit this tool is for is "add something above this". Child numbering
  // shifts on that; type numbering doesn't.
  test("survives a sibling of another type being inserted above", () => {
    const before = tree({ children: [{ children: [{ tag: "p" }], tag: "main" }], tag: "body" });

    const after = tree({
      children: [{ children: [{ tag: "h2" }, { tag: "p" }], tag: "main" }],
      tag: "body",
    });

    expect(selectorFor(find(before, "p"))).toBe(selectorFor(find(after, "p")));
  });

  // React's useId mints ids like `:r7:`, and a framework may mint a new one per
  // render. Anchoring to one truncates the path that would have worked.
  test("stops at a stable id, which is shorter and stronger, and ignores one that cannot survive a reload", () => {
    const under = (id: string) =>
      selectorFor(
        find(
          tree({
            children: [
              { children: [{ children: [{ tag: "span" }], tag: "div" }], id, tag: "section" },
            ],
            tag: "body",
          }),
          "span",
        ),
      );

    expect(under("hero")).toBe("#hero > div:nth-of-type(1) > span:nth-of-type(1)");
    expect(under(":r7:")).toBe("section:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)");
  });

  test("gives up at a depth that still describes an element, not a skeleton", () => {
    let spec: Spec = { tag: "span" };

    for (let depth = 0; depth < 14; depth += 1) spec = { children: [spec], tag: "div" };
    const root = tree({ children: [spec], tag: "body" });

    expect(selectorFor(find(root, "span")).split(" > ")).toHaveLength(8);
  });
});

test("elementText collapses a source file's whitespace, caps a paragraph, and is empty for no words", () => {
  expect(elementText("  Made in\n   Ghana  ")).toBe("Made in Ghana");
  // So one note cannot flood the brief.
  expect(elementText("x".repeat(200))).toHaveLength(80);
  expect(elementText("x".repeat(200)).endsWith("…")).toBe(true);
  expect(elementText(null)).toBe("");
});

describe("anchorFor", () => {
  const element = tree({
    children: [{ className: "pouch stage", tag: "div", text: "Made in Ghana" }],
    tag: "body",
  });

  test("records the four facts, rounded to whole pixels", () => {
    const anchor = anchorFor(
      find(element, "div"),
      { height: 220.4, width: 340.6, x: 512.2, y: 180.8 },
      1440,
    );

    expect(anchor).toEqual({
      classes: ["pouch", "stage"],
      rect: { height: 220, width: 341, x: 512, y: 181 },
      selector: "div:nth-of-type(1)",
      spot: { x: 0.5, y: 0.5 },
      tag: "div",
      text: "Made in Ghana",
      viewport: 1440,
    });
  });

  // The element may be a different size next time; a fraction survives that and
  // a coordinate doesn't.
  test("keeps the pointed-at spot as a fraction of the element, inside its own box", () => {
    const spot = (rect: Rect, point: { x: number; y: number }) =>
      anchorFor(find(element, "div"), rect, 1440, point).spot;

    const box = { height: 200, width: 400, x: 100, y: 100 };

    expect(spot(box, { x: 200, y: 150 })).toEqual({ x: 0.25, y: 0.25 });
    // A point outside the element stays on its edge.
    expect(spot(box, { x: -50, y: 9999 })).toEqual({ x: 0, y: 1 });
    // An element with no width to divide by: the middle.
    expect(spot({ height: 0, width: 0, x: 0, y: 0 }, { x: 10, y: 10 })).toEqual({ x: 0.5, y: 0.5 });
  });
});
