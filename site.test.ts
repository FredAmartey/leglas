import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAssets } from "./chrome.ts";
import { CAPTURES, renderHome } from "./home.ts";
import { buildSite } from "./site.ts";

const root = import.meta.dirname;

describe("the site", () => {
  test("the homepage carries the command, the captures and the way to the changelog", () => {
    const html = renderHome(loadAssets(root));
    expect(html).toContain('data-copy="npx leglas"');
    expect(html).toContain('href="./changelog/"');
    for (const capture of CAPTURES) {
      expect(html).toContain(`src="assets/${capture}"`);
      expect(existsSync(join(root, ".github", "assets", "screenshots", capture)), `${capture} is missing`).toBe(true);
    }
    // Self-contained apart from its own captures: nothing fetched from elsewhere.
    expect(html).not.toMatch(/src="https?:/);
  });

  test("the theme switch is in the bar, and the stored choice is stamped before the styles", () => {
    const html = renderHome(loadAssets(root));
    expect(html).toContain("data-theme-switch");
    const stamp = html.indexOf('localStorage.getItem("leglas-theme")');
    expect(stamp).toBeGreaterThan(0);
    expect(stamp).toBeLessThan(html.indexOf("<style>"));
  });

  test("builds both pages and the captures beside them", () => {
    const out = mkdtempSync(join(tmpdir(), "leglas-site-"));
    const written = buildSite(root, out);
    expect(written.map((path) => path.slice(out.length + 1)).sort()).toEqual(
      ["assets/compare-artboards.jpg", "assets/rail-single.jpg", "changelog/index.html", "index.html"].sort(),
    );
    expect(readFileSync(join(out, "changelog", "index.html"), "utf8")).toContain('href="../"');
  });
});
