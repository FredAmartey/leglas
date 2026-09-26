import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { PAGES } from "../site/docs.ts";

/**
 * `site/docs.ts` names the manual's pages so local notes in docs/ aren't
 * served. That leaves one silent mistake: a new page left off the list, which
 * builds, passes and never reaches the site. Git is the only thing that can
 * tell a page from a note.
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

/**
 * The index a reader sees is a second list, and a page missing from it is still
 * built and linked from the nav, so nobody notices. Checking where each name
 * appears avoids parsing markdown, which kept missing shapes.
 */
test("the index mentions every page, in the order the site shows them", () => {
  const index = readFileSync(join(root, "docs/README.md"), "utf8");
  const at = PAGES.map((page) => ({ page, index: index.indexOf(`${page}.md`) }));

  expect(at.filter((entry) => entry.index === -1).map((entry) => entry.page)).toEqual([]);
  expect(at.map((entry) => entry.page)).toEqual(
    [...at].sort((a, b) => a.index - b.index).map((entry) => entry.page),
  );
});
