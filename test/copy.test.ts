import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * `npx leglas` needs no install and every instruction Leglas writes uses it, so
 * an example telling someone to run bare `leglas explore hero` names something
 * not on their PATH. With both forms present nobody can tell which is meant.
 *
 * One construction, not a rule about the word: naming the command just run
 * ("leglas keep takes one direction title") and --help's usage block read fine
 * without the prefix. Widening this to "run" matches prose.
 */

const root = join(import.meta.dirname, "..");

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
 * Joins string literals split across lines, so a message is checked as the one
 * sentence it prints.
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
