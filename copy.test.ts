import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Nothing has to be installed to use Leglas: `npx leglas` fetches the CLI on
 * first use, and every instruction the tool writes for agents uses that form.
 * A message that tells someone to run `leglas explore hero` is telling them to
 * run something that is not on their PATH.
 *
 * That drifted once already. c81128b fixed one such example by hand and left
 * three siblings in the same file spelling it the other way, which is worse
 * than not having fixed it: with both forms present there is no way to tell
 * which one is meant.
 *
 * Deliberately one construction rather than a rule about the word "leglas".
 * The word appears in three roles and only this one wants the prefix: naming
 * the subcommand someone just ran ("leglas keep takes one direction title")
 * reads worse with it, and the usage block in --help is a usage block. Widening
 * this to "run" was tried and immediately matched prose. A check that fires on
 * correct code is a check somebody deletes.
 */

const root = import.meta.dirname;

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * Join string literals split across lines for width, so a message is read as
 * the one sentence it prints as. The classify example was written that way and
 * a line-at-a-time reading walked straight past it.
 */
const oneLine = (source: string): string => source.replace(/["'`]\s*\+\s*\n\s*["'`]/g, "");

/** `for example: leglas keep …`, but not `for example: npx leglas keep …`. */
const UNPREFIXED = /for example:?[^\n]*?(?<!npx )\bleglas [a-z]/g;

describe("what the CLI tells people to type", () => {
  test("every example is runnable without installing anything", () => {
    const offenders: string[] = [];

    for (const packageName of ["cli", "server", "shell", "mcp"]) {
      for (const file of sources(join(root, "packages", packageName, "src"))) {
        for (const line of oneLine(readFileSync(file, "utf8")).split("\n")) {
          for (const match of line.matchAll(UNPREFIXED)) {
            offenders.push(`${file.slice(root.length + 1)}: ${match[0].trim()}`);
          }
        }
      }
    }

    expect(offenders, "these examples need an npx prefix to work on a fresh clone").toEqual([]);
  });
});
