import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseChangelog, renderPage } from "./changelog.ts";
import { loadAssets } from "./chrome.ts";
import { CAPTURES, renderHome } from "./home.ts";

/**
 * The site: a homepage and the changelog, written under dist/site, which is
 * ignored, so nothing generated is ever committed. `pnpm site` runs this and
 * the Pages workflow does the same on main.
 */
export function buildSite(root: string, out: string): string[] {
  const assets = loadAssets(root);
  const changelog = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));

  mkdirSync(join(out, "changelog"), { recursive: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  const written: string[] = [];
  const write = (path: string, text: string): void => {
    writeFileSync(join(out, path), text);
    written.push(join(out, path));
  };

  write("index.html", renderHome(assets));
  write(join("changelog", "index.html"), renderPage(changelog, assets));
  // The homepage shows the README's captures, which stay in the tree because
  // they ship with the documentation.
  for (const capture of CAPTURES) {
    copyFileSync(join(root, ".github", "assets", "screenshots", capture), join(out, "assets", capture));
    written.push(join(out, "assets", capture));
  }
  return written;
}

if (import.meta.main) {
  const root = import.meta.dirname;
  for (const path of buildSite(root, join(root, "dist", "site"))) {
    process.stdout.write(`${path}\n`);
  }
}
