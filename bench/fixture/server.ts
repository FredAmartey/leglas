import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The app the journeys compare: one page with its directions behind `?v-hero=`,
 * the way a real app keeps variants behind a query parameter. No dependencies
 * and no clock, so every run serves the same bytes.
 *
 * Each direction paints its title at the same spot, and the page notes when
 * that title has painted. That note is the marker the runner looks for.
 *
 * `node server.ts --port <n>` listens on n, or on a free port for 0, and prints
 * `listening <port>` once it does: the `{port}` form a `devCommand` needs when
 * a branch direction joins the fixture.
 */

type Direction = { title: string; ground: string; lede: string };

const BASELINE: Direction = {
  title: "Baseline",
  ground: "#f4f1ea",
  lede: "The page as it ships today.",
};

const DIRECTIONS = new Map<string, Direction>([
  ["wave", { title: "Wave", ground: "#dfe9f5", lede: "A full-bleed band, anchored low." }],
  ["grid", { title: "Grid", ground: "#e8f0e2", lede: "A lattice of cards, three across." }],
]);

function page(direction: Direction): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${direction.title}</title>
<style>
  body { margin: 0; font: 16px/1.5 sans-serif; background: ${direction.ground}; }
  h1 { position: absolute; left: 48px; top: 48px; margin: 0; font-size: 40px; }
  p { position: absolute; left: 48px; top: 120px; margin: 0; max-width: 36rem; }
</style>
<h1 id="marker" elementtiming="marker">${direction.title}</h1>
<p>${direction.lede} The rest of this paragraph gives the duplicate scan enough text to tell one direction from another.</p>
<script>
  new PerformanceObserver((list) => {
    if (list.getEntries().some((entry) => entry.identifier === "marker")) {
      document.documentElement.dataset.painted = "marker";
    }
  }).observe({ type: "element", buffered: true });
</script>
</html>
`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");

  if (url.pathname !== "/") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found.");

    return;
  }

  const direction = DIRECTIONS.get(url.searchParams.get("v-hero") ?? "") ?? BASELINE;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page(direction));
});

function isTcp(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

const flag = process.argv.indexOf("--port");

server.listen(flag === -1 ? 0 : Number(process.argv[flag + 1] ?? 0), "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`listening ${isTcp(address) ? address.port : 0}\n`);
});
