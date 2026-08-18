import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addAnnotation,
  anchorFrom,
  annotationsFor,
  describeAnchor,
  describeAnnotations,
  readAnnotations,
  removeAnnotations,
  type Annotation,
  type AnnotationAnchor,
} from "./annotations.js";

const cwd = () => mkdtempSync(join(tmpdir(), "leglas-notes-"));

const anchor = (over: Partial<AnnotationAnchor> = {}): AnnotationAnchor => ({
  classes: ["pouch"],
  rect: { height: 220, width: 340, x: 512, y: 180 },
  selector: "main > div:nth-of-type(2)",
  spot: { x: 0.5, y: 0.5 },
  tag: "div",
  text: "Made in Ghana",
  viewport: 1440,
  ...over,
});

const note = (title: string, said: string): Omit<Annotation, "id"> => ({
  anchor: anchor(),
  note: said,
  title,
});

describe("anchorFrom", () => {
  test("takes an anchor the interface sent", () => {
    expect(anchorFrom(anchor())).toEqual(anchor());
  });

  // Without something to point at, a note is just a sentence with no address,
  // which is the thing the composer already does better.
  test("refuses an anchor with nothing to point at", () => {
    expect(anchorFrom({ ...anchor(), selector: "" })).toBeNull();
    expect(anchorFrom({ ...anchor(), selector: 42 })).toBeNull();
    expect(anchorFrom(null)).toBeNull();
    expect(anchorFrom("main > div")).toBeNull();
  });

  // Geometry that arrived broken is not a reason to lose the note; it is the
  // one part of an anchor the agent needs least.
  test("keeps a note whose geometry arrived malformed", () => {
    const read = anchorFrom({ ...anchor(), rect: { width: "wide" }, viewport: null });

    expect(read?.rect).toEqual({ height: 0, width: 0, x: 0, y: 0 });
    expect(read?.viewport).toBe(0);
    expect(read?.selector).toBe("main > div:nth-of-type(2)");
  });

  test("caps what a browser can put in the file", () => {
    const read = anchorFrom({
      ...anchor(),
      classes: Array.from({ length: 40 }, () => "x".repeat(200)),
      selector: "s".repeat(1000),
      text: "t".repeat(1000),
    });

    expect(read?.selector).toHaveLength(300);
    expect(read?.text).toHaveLength(120);
    expect(read?.classes).toHaveLength(8);
    expect(read?.classes[0]).toHaveLength(60);
  });

  test("keeps a pointed-at spot inside the element it belongs to", () => {
    expect(anchorFrom({ ...anchor(), spot: { x: -3, y: 40 } })?.spot).toEqual({ x: 0, y: 1 });
  });

  // Notes written before the spot existed sat at the middle of the element,
  // which is where they still belong.
  test("a note with no spot recorded lands in the middle", () => {
    const { spot, ...without } = anchor();
    expect(anchorFrom(without)?.spot).toEqual({ x: 0.5, y: 0.5 });
  });

  test("names an element that arrived without a tag", () => {
    expect(anchorFrom({ ...anchor(), tag: "" })?.tag).toBe("element");
  });
});

describe("the notes file", () => {
  test("has nothing to say about a project that has never been annotated", async () => {
    const root = cwd();
    expect(await readAnnotations(root)).toEqual([]);
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });

  test("keeps notes in the order they were left", async () => {
    const root = cwd();
    await addAnnotation(root, note("Poster", "looks fake"));
    await addAnnotation(root, note("Poster", "wrong on its side"));

    expect((await readAnnotations(root)).map((entry) => entry.note)).toEqual([
      "looks fake",
      "wrong on its side",
    ]);
  });

  test("gives every note an id of its own", async () => {
    const root = cwd();
    const first = await addAnnotation(root, note("Poster", "a"));
    const second = await addAnnotation(root, note("Poster", "b"));

    expect(first.id).not.toBe(second.id);
  });

  test("drops the notes it is asked to and reports how many there were", async () => {
    const root = cwd();
    const first = await addAnnotation(root, note("Poster", "a"));
    await addAnnotation(root, note("Poster", "b"));

    expect(await removeAnnotations(root, [first.id, "never-existed"])).toBe(1);
    expect((await readAnnotations(root)).map((entry) => entry.note)).toEqual(["b"]);
  });

  test("forgetting nothing leaves no trace on disk", async () => {
    const root = cwd();
    expect(await removeAnnotations(root, ["nope"])).toBe(0);
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });

  test("an unreadable file reads as no notes rather than stopping the interface", async () => {
    const root = cwd();
    mkdirSync(join(root, ".leglas"));
    writeFileSync(join(root, ".leglas/annotations.json"), "{ not json");

    expect(await readAnnotations(root)).toEqual([]);
  });

  test("skips an entry with nothing to point at rather than reading it back broken", async () => {
    const root = cwd();
    mkdirSync(join(root, ".leglas"));
    writeFileSync(
      join(root, ".leglas/annotations.json"),
      JSON.stringify({
        annotations: [
          { anchor: anchor(), id: "a", note: "fine", title: "Poster" },
          { id: "b", note: "no anchor", title: "Poster" },
          { anchor: anchor(), id: "c", note: "no title" },
        ],
      }),
    );

    expect((await readAnnotations(root)).map((entry) => entry.id)).toEqual(["a"]);
  });

  test("writes a file a person can read", async () => {
    const root = cwd();
    await addAnnotation(root, note("Poster", "looks fake"));
    const raw = readFileSync(join(root, ".leglas/annotations.json"), "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"note": "looks fake"');
  });
});

describe("annotationsFor", () => {
  test("takes only the notes left on the direction asked about", () => {
    const notes: Annotation[] = [
      { anchor: anchor(), id: "1", note: "a", title: "Poster" },
      { anchor: anchor(), id: "2", note: "b", title: "Orchard" },
      { anchor: anchor(), id: "3", note: "c", title: "Poster" },
    ];

    expect(annotationsFor(notes, "Poster").map((entry) => entry.id)).toEqual(["1", "3"]);
  });
});

describe("describeAnchor", () => {
  test("leads with what survives a change and ends with what does not", () => {
    expect(describeAnchor(anchor())).toBe(
      '<div>, class "pouch", reading “Made in Ghana”; ' +
        "path main > div:nth-of-type(2); about 340×220 at (512, 180) in a 1440px-wide viewport",
    );
  });

  test("leaves out what an element does not have", () => {
    expect(describeAnchor(anchor({ classes: [], tag: "svg", text: "" }))).toBe(
      "<svg>; path main > div:nth-of-type(2); about 340×220 at (512, 180) in a 1440px-wide viewport",
    );
  });
});

describe("describeAnnotations", () => {
  test("numbers the notes the way the pins are numbered", () => {
    const written = describeAnnotations([
      { anchor: anchor(), id: "1", note: "looks fake", title: "Poster" },
      { anchor: anchor({ tag: "img" }), id: "2", note: "wrong on its side", title: "Poster" },
    ]);

    expect(written).toContain("1. looks fake");
    expect(written).toContain("2. wrong on its side");
    expect(written.indexOf("1. ")).toBeLessThan(written.indexOf("2. "));
  });

  test("a pin dropped without words still says where to look", () => {
    expect(describeAnnotations([{ anchor: anchor(), id: "1", note: "", title: "Poster" }])).toContain(
      "1. Look at this.",
    );
  });
});
