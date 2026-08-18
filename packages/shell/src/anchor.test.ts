import { describe, expect, test } from "vitest";

import { anchorFor, elementText, selectorFor, type ElementLike } from "./anchor.js";

/** A tree the selector walk can climb, shaped like the DOM's own. */
function tree(spec: {
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  children?: (typeof spec)[];
}): ElementLike {
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
  (node as unknown as { children: ElementLike[] }).children = children;
  return node;
}

const find = (root: ElementLike, tag: string, nth = 1): ElementLike => {
  let seen = 0;
  const walk = (node: ElementLike): ElementLike | null => {
    if (node.tagName === tag.toUpperCase()) {
      seen += 1;
      if (seen === nth) return node;
    }
    for (let at = 0; at < node.children.length; at += 1) {
      const hit = walk(node.children[at] as ElementLike);
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

  // The edit this tool exists to make is "add something above this". Child
  // numbering renumbers on that; type numbering does not.
  test("survives a sibling of another type being inserted above", () => {
    const before = tree({ children: [{ children: [{ tag: "p" }], tag: "main" }], tag: "body" });
    const after = tree({
      children: [{ children: [{ tag: "h2" }, { tag: "p" }], tag: "main" }],
      tag: "body",
    });

    expect(selectorFor(find(before, "p"))).toBe(selectorFor(find(after, "p")));
  });

  test("stops at a stable id, which is shorter and stronger", () => {
    const root = tree({
      children: [{ children: [{ children: [{ tag: "span" }], tag: "div" }], id: "hero", tag: "section" }],
      tag: "body",
    });

    expect(selectorFor(find(root, "span"))).toBe("#hero > div:nth-of-type(1) > span:nth-of-type(1)");
  });

  // React's useId mints ids like `:r7:`, and a framework may mint a fresh one
  // per render. Anchoring to one truncates the path that would have worked.
  test("ignores an id that cannot survive a reload", () => {
    const root = tree({
      children: [{ children: [{ tag: "span" }], id: ":r7:", tag: "section" }],
      tag: "body",
    });

    expect(selectorFor(find(root, "span"))).toBe("section:nth-of-type(1) > span:nth-of-type(1)");
  });

  test("gives up at a depth that still describes an element, not a skeleton", () => {
    let spec: { tag: string; children?: unknown[] } = { tag: "span" };
    for (let depth = 0; depth < 14; depth += 1) spec = { children: [spec], tag: "div" };
    const root = tree({ children: [spec], tag: "body" } as Parameters<typeof tree>[0]);

    expect(selectorFor(find(root, "span")).split(" > ")).toHaveLength(8);
  });
});

describe("elementText", () => {
  test("collapses the whitespace a source file leaves behind", () => {
    expect(elementText("  Made in\n   Ghana  ")).toBe("Made in Ghana");
  });

  test("caps a paragraph so one note cannot flood the brief", () => {
    expect(elementText("x".repeat(200))).toHaveLength(80);
    expect(elementText("x".repeat(200)).endsWith("…")).toBe(true);
  });

  test("has nothing to say about an element with no words", () => {
    expect(elementText(null)).toBe("");
  });
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

  // The pin has to come back where it was meant when the element is a
  // different size next time, which a fraction survives and a coordinate
  // does not.
  test("keeps the pointed-at spot as a fraction of the element", () => {
    const anchor = anchorFor(
      find(element, "div"),
      { height: 200, width: 400, x: 100, y: 100 },
      1440,
      { x: 200, y: 150 },
    );

    expect(anchor.spot).toEqual({ x: 0.25, y: 0.25 });
  });

  test("keeps a point outside the element inside its own box", () => {
    const anchor = anchorFor(
      find(element, "div"),
      { height: 200, width: 400, x: 100, y: 100 },
      1440,
      { x: -50, y: 9999 },
    );

    expect(anchor.spot).toEqual({ x: 0, y: 1 });
  });

  test("falls back to the middle when an element has no width to divide by", () => {
    const anchor = anchorFor(
      find(element, "div"),
      { height: 0, width: 0, x: 0, y: 0 },
      1440,
      { x: 10, y: 10 },
    );

    expect(anchor.spot).toEqual({ x: 0.5, y: 0.5 });
  });
});
