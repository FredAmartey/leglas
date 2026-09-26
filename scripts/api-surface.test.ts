import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SNAPSHOT, publicSurface, resolve, topLevelDeclarations } from "./api-surface.js";

/**
 * The snapshot is the published promise; this catches the build drifting from
 * it in the PR that caused it. A failure means an exported signature moved: run
 * `pnpm api:update`, then check the planned version still fits.
 */
describe("the public API surface", () => {
  test("matches the snapshot", () => {
    const root = join(import.meta.dirname, "..");
    const recorded = readFileSync(join(root, SNAPSHOT), "utf8");

    expect(
      publicSurface(root),
      `${SNAPSHOT} is out of date. Run \`pnpm api:update\`, read the diff, and if it ` +
        "changes what an importer sees, the next release is not a patch.",
    ).toBe(recorded);
  });
});

/**
 * `tsc` copies JSDoc into the declarations. An earlier reader counted brackets
 * in that prose, and one unmatched `(` swallowed its declaration, which then
 * read as an external name while the snapshot test passed.
 */
describe("reading declarations", () => {
  const declarationOf = (source: string, name: string): string =>
    topLevelDeclarations(source).get(name) ?? "";

  test("an unbalanced bracket in a comment does not swallow the declaration", () => {
    for (const prose of ["(see below", "a } here", "an unmatched [", "and a ) too"]) {
      const source = [
        "export declare function f(options: {",
        `    /** Prose with ${prose} in it. */`,
        "    kept: string;",
        "}): void;",
      ].join("\n");

      expect(declarationOf(source, "f"), `broke on ${JSON.stringify(prose)}`).toContain(
        "kept: string;",
      );
    }
  });

  test("a bracket inside a string literal is not counted", () => {
    const source = 'export declare const MARKER = "<!-- leglas:start ({[ -->";';
    expect(declarationOf(source, "MARKER")).toContain("leglas:start");
  });

  test("a line comment that looks like a declaration does not start one", () => {
    const source = [
      "// export type Fake = { never: true };",
      "export type Real = {",
      "    yes: true;",
      "};",
    ].join("\n");

    const found = topLevelDeclarations(source);
    expect([...found.keys()]).toEqual(["Real"]);
  });

  test("consecutive declarations are kept apart", () => {
    const source = [
      "export declare function first(): void;",
      "export type Second = {",
      "    /** Closing brace in prose: } */",
      "    value: string;",
      "};",
      "export declare const third = 3;",
    ].join("\n");

    expect([...topLevelDeclarations(source).keys()]).toEqual(["first", "Second", "third"]);
  });
});

/**
 * Names are followed along the path they travel. A flat index by name lets a
 * module-local declaration reached first stand in for a public one of the same
 * name, and the snapshot would describe a type nobody exports.
 */
describe("resolving a name through re-exports", () => {
  const dist = (files: Record<string, string>): string => {
    const directory = mkdtempSync(join(tmpdir(), "leglas-surface-"));

    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(directory, name), contents);
    }

    return directory;
  };

  test("a same-named declaration in another module cannot stand in", () => {
    const directory = dist({
      // Listed first, so anything walking breadth-first meets its Thing first.
      "index.d.ts": [
        'export { helper } from "./helpers.js";',
        'export type { Thing } from "./public.js";',
      ].join("\n"),
      "helpers.d.ts": [
        "export type Thing = {",
        "    wrong: true;",
        "};",
        "export declare function helper(): Thing;",
      ].join("\n"),
      "public.d.ts": ["export type Thing = {", "    right: true;", "};"].join("\n"),
    });

    const found = resolve(directory, join(directory, "index.d.ts"), "Thing", new Set());

    expect(found.kind).toBe("found");
    expect(found.kind === "found" ? found.text : "").toContain("right: true;");
  });

  test("a chain that leaves the repository is reported, not guessed at", () => {
    const directory = dist({
      "index.d.ts": 'export { readRequests } from "@somewhere/else";',
    });

    const found = resolve(directory, join(directory, "index.d.ts"), "readRequests", new Set());
    expect(found).toEqual({ kind: "external", from: "@somewhere/else" });
  });

  test("a name nothing on the chain declares is missing, not silently absent", () => {
    const directory = dist({
      "index.d.ts": 'export { Gone } from "./real.js";',
      "real.d.ts": "export type Present = { yes: true };",
    });

    const found = resolve(directory, join(directory, "index.d.ts"), "Gone", new Set());
    expect(found).toEqual({ kind: "missing" });
  });

  // The guarantee is the refusal: a surface with a hole in it is not written.
  test("the surface refuses to build around a name nothing declares", () => {
    const root = mkdtempSync(join(tmpdir(), "leglas-surface-root-"));

    for (const [dir, files] of [
      [
        "packages/cli/dist",
        {
          "index.d.ts": 'export { Gone } from "./real.js";',
          "real.d.ts": "export type Present = { yes: true };",
        },
      ],
      [
        "packages/mcp/dist",
        {
          "index.d.ts": 'export { Present } from "./real.js";',
          "real.d.ts": "export type Present = { yes: true };",
        },
      ],
    ] as const) {
      mkdirSync(join(root, dir), { recursive: true });

      for (const [name, contents] of Object.entries(files))
        writeFileSync(join(root, dir, name), contents);
    }

    expect(() => publicSurface(root)).toThrow(
      "leglas exports Gone, but no module on the chain declares it",
    );
  });
});
