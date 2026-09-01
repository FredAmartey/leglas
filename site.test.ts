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
    // Which way it goes depends on the reader, so the markup cannot claim one.
    expect(html).toContain('aria-label="Switch between light and dark"');
    expect(html).toContain("<noscript><style>.theme,.share{display:none}</style></noscript>");
  });

  test("the theme arrives as a circle opening from the switch", () => {
    const html = renderHome(loadAssets(root));
    expect(html).toContain("@keyframes theme-reveal");
    expect(html).toContain("::view-transition-new(root)");
    // Measured at the click, not baked into the stylesheet.
    expect(html).toContain('setProperty("--vt-x"');
    expect(html).toContain("Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))");
    // The sweep is motion, so it belongs to readers who did not ask for less.
    expect(html).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{\s*::view-transition-new\(root\)\{animation:theme-reveal/);
    expect(html).toContain("matchMedia(\"(prefers-reduced-motion: reduce)\").matches");
    // A hidden document rejects, and an unread rejection reaches the console.
    expect(html).toContain(".ready.catch(function(){})");
  });

  test("the hero offers a star and a share beside the command", () => {
    const html = renderHome(loadAssets(root));
    // The star is a plain link to the repository, so it works without a script.
    expect(html).toMatch(/<a class="action star" href="https:\/\/github\.com\/FredAmartey\/leglas">[\s\S]*?Star on GitHub<\/a>/);
    expect(html).toContain('<button class="action share" type="button" data-share=');
    // Share copies the address on a desk and goes to the system sheet on a phone.
    expect(html).toContain('navigator.share&&matchMedia("(hover: none)").matches');
    expect(html).toContain("navigator.share(data).catch(function(){})");
    expect(html).toContain("navigator.clipboard.writeText(data.url)");
    expect(html).toContain("url:location.origin+location.pathname");
    // Without a script the share control would do nothing, so it goes with the theme switch.
    expect(html).toContain("<noscript><style>.theme,.share{display:none}</style></noscript>");
    // The swap rides a spring, with a bezier before it for browsers that drop linear().
    expect(html).toMatch(/transition-timing-function:cubic-bezier\([^)]*\),ease;transition-timing-function:linear\(/);
    expect(html).toContain("@media (prefers-reduced-motion:reduce){.action,.action .icon>*,.spark{transition:none}}");
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
