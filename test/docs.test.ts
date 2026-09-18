import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";

import { PAGES } from "../site/docs.ts";

/**
 * The manual names its pages in `site/docs.ts` rather than finding them, so
 * that the uncommitted notes this repository keeps in the same folder,
 * `docs/lessons.md` and `docs/plans/`, are not served as part of it.
 *
 * That leaves one way to go wrong: write a page, link it from the index, and
 * forget the list. Nothing would say so. The site would build, the suite
 * would pass, and the page would simply not be on leglas.vercel.app.
 *
 * So the question is asked here instead, of git, which is the only thing that
 * can tell a page of the manual from a note somebody keeps beside it.
 */
const root = join(import.meta.dirname, "..");

const committed = (): string[] => {
  const result = spawnSync("git", ["ls-files", "docs/*.md"], { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice("docs/".length, -".md".length));
};

test("every committed page of the manual is one the site knows to serve", () => {
  expect([...committed()].sort()).toEqual(["README", ...PAGES].sort());
});
