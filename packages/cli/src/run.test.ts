import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { run, type RunDeps } from "./run.js";

const inspectDevServer = vi.hoisted(() => vi.fn());
vi.mock("./dev-server-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dev-server-owner.js")>();
  return { ...actual, inspectLocalDevServer: inspectDevServer };
});

const stopping: Array<() => Promise<void>> = [];
const origins: http.Server[] = [];

afterEach(async () => {
  await Promise.all(stopping.splice(0).map((stop) => stop()));
  await Promise.all(
    origins.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});

beforeEach(() => {
  inspectDevServer.mockResolvedValue([]);
});

function startOrigin(): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("app");
  });
  origins.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function harness() {
  const opened: string[] = [];
  const out: string[] = [];
  const deps: RunDeps = {
    open: async (url) => void opened.push(url),
    log: (line) => void out.push(line),
  };
  return { deps, opened, output: () => out.join("\n") };
}

function projectWith(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "leglas-cli-"));
  writeFileSync(join(dir, "leglas.config.ts"), config);
  return dir;
}

async function boot(
  cwd: string,
  options: Partial<Parameters<typeof run>[0]> = {},
) {
  const { deps, opened, output } = harness();
  const result = await run(
    { port: 0, userPort: undefined, configPath: undefined, open: true, json: false, cwd, ...options },
    deps,
  );
  stopping.push(result.stop);
  // Snapshot the log after run() has finished writing to it.
  return { result, opened, output: output() };
}

describe("run", () => {
  test("boots against the config's dev server and reports its url", async () => {
    const port = await startOrigin();
    const dir = projectWith(
      `export default { devServer: "http://127.0.0.1:${port}", previews: [{ title: "App", url: "/" }] };`,
    );

    const { result } = await boot(dir);

    expect(result.exitCode).toBe(0);
    expect(result.url).toMatch(/^http:\/\/localhost:\d+\/leglas$/);
  });

  test("opens the browser at the interface, not at the app", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:${port}", previews: [] };`);

    const { opened, result } = await boot(dir);

    expect(opened).toEqual([result.url]);
  });

  test("leaves the browser alone when told to", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:${port}", previews: [] };`);

    const { opened } = await boot(dir, { open: false });

    expect(opened).toEqual([]);
  });

  test("--user-port overrides the configured dev server", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:9999", previews: [] };`);

    const { result } = await boot(dir, { userPort: port });

    expect(result.devServer).toBe(`http://localhost:${port}`);
  });

  test("runs with no config at all, previewing the app root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leglas-cli-empty-"));

    const { result } = await boot(dir);

    expect(result.exitCode).toBe(0);
    expect(result.previewCount).toBe(1);
  });

  test("still starts when the config is invalid, and says what is wrong", async () => {
    const dir = projectWith(`export default { previews: [{ url: "/" }] };`);

    const { result, output } = await boot(dir);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("title");
  });

  test("warns when the dev server is not reachable, rather than failing silently", async () => {
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:1", previews: [] };`);

    const { output } = await boot(dir);

    expect(output.toLowerCase()).toContain("not reachable");
  });

  test("prints a single json envelope for agents", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:${port}", previews: [] };`);

    const { output } = await boot(dir, { json: true, open: false });
    const envelope = JSON.parse(output) as { ok: boolean; url: string };

    expect(envelope.ok).toBe(true);
    expect(envelope.url).toContain("/leglas");
  });

  test("names the config file it used, so a surprising config is findable", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:${port}", previews: [] };`);

    const { output } = await boot(dir);

    expect(output).toContain("leglas.config.ts");
  });

  test("warns without blocking when a local dev server belongs to another project", async () => {
    const port = await startOrigin();
    const dir = projectWith(`export default { devServer: "http://127.0.0.1:${port}", previews: [{ title: "App", url: "/" }] };`);

    inspectDevServer.mockResolvedValueOnce([
      { pid: 42, cwd: "/work/other-app" },
    ]);
    const { output, result } = await boot(dir, { open: false });
    const config = (await (
      await fetch(`${result.url.replace(/\/leglas$/, "")}/leglas/api/config`)
    ).json()) as { warnings: string[] };

    expect(output).toContain(`Port ${port} appears to be served from other-app`);
    expect(config.warnings).toEqual([
      expect.stringContaining("outside this project"),
    ]);
    expect(result.exitCode).toBe(0);
  });
});

describe("branch previews without a devCommand", () => {
  test("reports the missing devCommand and skips the preview instead of showing the wrong server", async () => {
    const port = await startOrigin();
    const dir = projectWith(
      `export default { devServer: "http://127.0.0.1:${port}", previews: [{ title: "App", url: "/" }] };`,
    );
    mkdirSync(join(dir, ".leglas"), { recursive: true });
    writeFileSync(
      join(dir, ".leglas", "previews.json"),
      JSON.stringify({ previews: [{ title: "PR", url: "/", branch: "main" }] }),
    );

    const { result, output } = await boot(dir, { open: false });

    expect(result.previewCount).toBe(1);
    expect(output).toContain("devCommand");
    expect(output).toContain("PR");
  });
});

describe("greenfield", () => {
  test("serves a file preview from the Leglas origin, with no dev server at all", async () => {
    const dir = projectWith(
      `export default { previews: [{ title: "Aurora", file: "pages/aurora.html" }] };`,
    );
    mkdirSync(join(dir, "pages"), { recursive: true });
    writeFileSync(join(dir, "pages", "aurora.html"), "<!doctype html><h1>aurora page</h1>");
    writeFileSync(join(dir, "pages", "style.css"), "h1{color:teal}");

    const { result } = await boot(dir, { open: false });

    const config = (await (
      await fetch(`${result.url.replace(/\/leglas$/, "")}/leglas/api/config`)
    ).json()) as { previews: { title: string; url: string }[] };
    const preview = config.previews[0];
    expect(preview?.url).toContain("/leglas/files/");

    const base = result.url.replace(/\/leglas$/, "");
    const page = await fetch(`${base}${preview?.url}`);
    expect(await page.text()).toContain("aurora page");

    const asset = await fetch(`${base}${preview?.url.replace("aurora.html", "style.css")}`);
    expect(await asset.text()).toContain("teal");
  });

  test("reports a file preview whose file does not exist, and skips it", async () => {
    const dir = projectWith(
      `export default { previews: [{ title: "Ghost", file: "pages/missing.html" }] };`,
    );

    const { result, output } = await boot(dir, { open: false });

    expect(result.previewCount).toBe(0);
    expect(output).toContain("does not exist");
  });

  test("starts the app itself when nothing is listening and the config says how", async () => {
    const dir = projectWith("placeholder");
    writeFileSync(
      join(dir, "app.mjs"),
      `import http from "node:http";\n` +
        `http.createServer((q, s) => s.end("greenfield-app")).listen(Number(process.argv[2]), "127.0.0.1");\n`,
    );
    writeFileSync(
      join(dir, "leglas.config.ts"),
      `export default {\n` +
        `  devServer: "http://127.0.0.1:1",\n` +
        `  devCommand: "node app.mjs {port}",\n` +
        `  previews: [{ title: "App", url: "/" }],\n` +
        `};`,
    );

    const { result, output } = await boot(dir, { open: false });

    expect(output).toContain("started by Leglas");
    const base = result.url.replace(/\/leglas$/, "");
    const proxied = await fetch(`${base}/`);
    expect(await proxied.text()).toBe("greenfield-app");
  });

  test("does not start the app behind an explicit --user-port", async () => {
    const dir = projectWith("placeholder");
    writeFileSync(join(dir, "app.mjs"), `process.exit(0);`);
    writeFileSync(
      join(dir, "leglas.config.ts"),
      `export default {\n` +
        `  devCommand: "node app.mjs {port}",\n` +
        `  previews: [{ title: "App", url: "/" }],\n` +
        `};`,
    );

    const { output } = await boot(dir, { open: false, userPort: 1 });

    expect(output).not.toContain("started by Leglas");
    expect(output).toContain("not reachable");
  });
});
