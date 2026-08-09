import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SNAPSHOT, publicSurface, topLevelDeclarations } from "./api-surface.js";

/**
 * The snapshot is the published promise. This is the half that notices when
 * the build stops matching it, which is the moment the change is still cheap:
 * in the pull request that caused it, rather than against a tag, where the
 * only fix is another release.
 *
 * Failing here is not a defect. It means an exported signature moved, and the
 * two things to do about it are to run `pnpm api:update` and then to ask
 * whether the version being planned still describes what consumers will get.
 */
describe("the public API surface", () => {
  test("matches the snapshot", () => {
    const root = import.meta.dirname;
    const recorded = readFileSync(join(root, SNAPSHOT), "utf8");

    expect(
      publicSurface(root),
      `${SNAPSHOT} is out of date. Run \`pnpm api:update\`, read the diff, and if it ` +
        "changes what an importer sees, the next release is not a patch.",
    ).toBe(recorded);
  });
});

/**
 * `tsc` copies JSDoc into the declarations, so the reader spends most of its
 * time looking at prose written by whoever wrote the source. Prose contains
 * brackets, and an earlier version counted them: one unmatched `(` in a
 * comment swallowed the declaration it was attached to, which then read as an
 * unresolvable external name rather than as a failure. A signature change
 * underneath it was invisible, and the snapshot test passed.
 *
 * That is the failure worth guarding: not a wrong answer, a confident one.
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
