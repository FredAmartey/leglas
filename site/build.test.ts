import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseChangelog, renderPage } from "./changelog.ts";
import { loadAssets } from "./chrome.ts";
import { CAPTURES, renderHome } from "./home.ts";
import { buildSite } from "./build.ts";
import { docsPath, loadDocs } from "./docs.ts";
// The server's own browser launcher, the one captures use.
import {
  findBrowser,
  launchBrowser,
  type CdpPage,
} from "../packages/server/src/capture/browser.ts";
import { boundPort } from "../packages/server/src/test-helpers.ts";

const root = join(import.meta.dirname, "..");

describe("the site", () => {
  test("the homepage carries the command, the captures and the way to the changelog", () => {
    const html = renderHome(loadAssets(root));
    expect(html).toContain('data-copy="npx leglas"');
    expect(html).toContain('href="./changelog/"');

    for (const capture of CAPTURES) {
      expect(html).toContain(`src="assets/${capture}"`);
      expect(
        existsSync(join(root, ".github", "assets", "screenshots", capture)),
        `${capture} is missing`,
      ).toBe(true);
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
    expect(html).toContain("<noscript><style>.theme{display:none}</style></noscript>");
  });

  test("the bar carries a star on both pages", () => {
    const assets = loadAssets(root);
    const home = renderHome(assets);

    const changelog = renderPage(
      parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8")),
      assets,
    );

    for (const html of [home, changelog]) {
      // A plain link to the repository, so it works without a script.
      const star =
        /<a\b[^>]*href="https:\/\/github\.com\/FredAmartey\/leglas"[^>]*>([\s\S]*?)<\/a>/.exec(
          html,
        );

      expect(star?.[1]?.replace(/<[^>]+>/g, " ")).toContain("Star on GitHub");
    }

    // Nothing on the site shares any more.
    expect(home).not.toContain("data-share");
    expect(home).not.toContain("navigator.share");
  });

  test("builds the pages, the docs and the captures beside them", () => {
    const out = mkdtempSync(join(tmpdir(), "leglas-site-"));
    const written = buildSite(root, out);
    // From the manual's own index, like the build, so an uncommitted note in
    // the same folder is not expected on the site.
    const docs = loadDocs(root).map((entry) => docsPath(entry.slug));
    expect(written.map((path) => path.slice(out.length + 1)).sort()).toEqual(
      [
        "assets/compare-artboards.jpg",
        "assets/rail-single.jpg",
        "changelog/index.html",
        "index.html",
        "releases.json",
        ...docs,
      ].sort(),
    );
    expect(readFileSync(join(out, "changelog", "index.html"), "utf8")).toContain('href="../"');
  });
});

/** Serve one page on loopback, so storage and view transitions behave as they do online. */
async function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));

  return {
    url: `http://127.0.0.1:${boundPort(server)}/`,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

async function evaluate<T>(tab: CdpPage, expression: string): Promise<T> {
  const answer = await tab.send<{ result: { value: T } }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  return answer.result.value;
}

async function load(tab: CdpPage, url: string): Promise<void> {
  const loaded = new Promise<void>((done) => {
    const stop = tab.on("Page.loadEventFired", () => {
      stop();
      done();
    });
  });

  await tab.send("Page.navigate", { url });
  await loaded;
}

/** The deadline bounds a hang; it is not an assertion about speed. */
async function until(tab: CdpPage, condition: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!(await evaluate<boolean>(tab, condition))) {
    if (Date.now() > deadline) throw new Error(`never held: ${condition}`);
    await new Promise((tick) => setTimeout(tick, 25));
  }
}

const executable = findBrowser();

// What the switch's own comment in chrome.ts promises: the theme flips from
// whatever is showing, the circle opens from the button's centre, a reader
// who asked for less motion gets the flip alone, and the choice is kept.
describe.skipIf(executable === null || process.env.CODEX_SANDBOX === "seatbelt")(
  "the theme switch in a real browser",
  () => {
    test.each([
      ["no-preference", 1],
      ["reduce", 0],
    ] as const)(
      "with reduced motion %s, a click flips the theme from the switch (%i view transitions)",
      async (motion, transitions) => {
        const page = await serve(renderHome(loadAssets(root)));
        const browser = await launchBrowser(executable ?? "");

        try {
          await browser.withPage(async (tab) => {
            await tab.send("Page.enable");

            await tab.send("Emulation.setEmulatedMedia", {
              features: [
                { name: "prefers-color-scheme", value: "light" },
                { name: "prefers-reduced-motion", value: motion },
              ],
            });

            await load(tab, page.url);

            await evaluate(
              tab,
              "window.transitions = 0; const start = document.startViewTransition; if (start) document.startViewTransition = (update) => { window.transitions += 1; return start.call(document, update); }; true",
            );

            const centre = await evaluate<{ x: number; y: number }>(
              tab,
              'JSON.parse(JSON.stringify((() => { const box = document.querySelector("[data-theme-switch]").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()))',
            );

            for (const type of ["mousePressed", "mouseReleased"]) {
              await tab.send("Input.dispatchMouseEvent", {
                type,
                x: centre.x,
                y: centre.y,
                button: "left",
                clickCount: 1,
              });
            }

            await until(tab, 'document.documentElement.dataset.theme === "dark"');
            expect(await evaluate<number>(tab, "window.transitions")).toBe(transitions);

            expect(
              await evaluate<string>(
                tab,
                'document.documentElement.style.getPropertyValue("--vt-x")',
              ),
            ).toBe(`${centre.x}px`);

            expect(
              await evaluate<string>(
                tab,
                'document.documentElement.style.getPropertyValue("--vt-y")',
              ),
            ).toBe(`${centre.y}px`);

            // Kept: the next visit starts dark.
            await load(tab, page.url);
            expect(await evaluate<string>(tab, "document.documentElement.dataset.theme")).toBe(
              "dark",
            );
          });
        } finally {
          await browser.close();
          await page.close();
        }
      },
    );
  },
);
