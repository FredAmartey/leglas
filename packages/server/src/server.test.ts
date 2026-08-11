import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveAgentChoice } from "./agents.js";
import type { LeglasConfig } from "./config.js";
import { appendRequest } from "./requests.js";
import { startServer, type RunningServer } from "./server.js";

const running: RunningServer[] = [];
const origins: http.Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(
    origins.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  vi.restoreAllMocks();
});

/** Stand-in dev server. Answers anything with a marker so proxying is visible. */
function startOrigin(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>app:${req.url}</h1>`);
  });
  origins.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function configFor(port: number, previews: LeglasConfig["previews"] = []): LeglasConfig {
  return { devServer: `http://127.0.0.1:${port}`, previews };
}

async function start(options: Parameters<typeof startServer>[0]): Promise<RunningServer> {
  const server = await startServer(options);
  running.push(server);
  return server;
}

describe("startServer", () => {
  test("POST then GET exposes queued request state without collecting it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-api-"));
    const server = await start({ config: configFor(await startOrigin(), [{ title: "Aurora", url: "/" }]), port: 0, cwd });
    const posted = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Aurora", intent: "warmer" }),
    });
    expect(posted.status).toBe(200);
    const first = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as { requests: { id: string; status: string; intent: string }[] };
    expect(first.requests).toMatchObject([{ id: expect.any(String), status: "queued", intent: "warmer" }]);
    const second = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as typeof first;
    expect(second).toEqual(first);
  });

  test("reads the queue without collecting it, so watch still has work to do", async () => {
    // Reading is what the interface does three times a second. If it marked
    // anything, the queue would empty itself just by being looked at.
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-read-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: unknown[];
      agent: { attached: boolean };
    };

    expect(body.requests).toEqual([]);
    expect(body.agent).toEqual({
      attached: false,
      running: false,
      name: null,
      activity: null,
    });
    expect(existsSync(join(cwd, ".leglas"))).toBe(false);
  });

  test("reports available agents and round-trips the saved choice", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-api-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const initial = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: { id: string; name: string; available: boolean }[];
      choice: string | null;
      customRun: string | null;
    };
    expect(initial.agents).toEqual([
      { id: "claude", name: "Claude", available: expect.any(Boolean) },
      { id: "codex", name: "Codex", available: expect.any(Boolean) },
      { id: "cursor", name: "Cursor", available: expect.any(Boolean) },
    ]);
    expect(initial.choice).toBeNull();
    expect(initial.customRun).toBeNull();

    const customRun = "my-agent -p {prompt}";
    const saved = await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "custom", run: customRun }),
    });
    expect(saved.status).toBe(200);

    const custom = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as typeof initial;
    expect(custom).toMatchObject({ choice: "custom", customRun });

    await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex" }),
    });
    const known = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as typeof initial;
    expect(known).toMatchObject({ choice: "codex", customRun });
  });

  test.each([
    { agent: "unknown" },
    { agent: "custom" },
    { agent: "custom", run: "node" },
    { agent: "codex", run: 42 },
  ])("refuses an invalid agent choice: %j", async (choice) => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const response = await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(choice),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  test("refuses cross-origin agent configuration before it reaches disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-origin-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.invalid",
      },
      body: JSON.stringify({ agent: "custom", run: "sh -c 'exit 0' {prompt}" }),
    });

    expect(response.status).toBe(403);
    expect(existsSync(join(cwd, ".leglas/watch.json"))).toBe(false);
  });

  test("refuses a safelisted content type for agent configuration", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-content-type-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ agent: "custom", run: "sh -c 'exit 0' {prompt}" }),
    });

    expect(response.status).toBe(400);
    expect(existsSync(join(cwd, ".leglas/watch.json"))).toBe(false);
  });

  test("reports a running request and cancels it through the polled API", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-runner-api-"));
    await saveAgentChoice(cwd, {
      agent: "custom",
      run: 'node -e "setInterval(() => {}, 1000)" {prompt}',
    });
    await appendRequest(cwd, {
      title: "Aurora",
      url: "/",
      intent: "warmer",
      target: null,
      prompt: "make it warmer",
    });
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });
    type RequestsBody = {
      requests: { status: string }[];
      agent: { attached: boolean; running: boolean; name: string | null; activity: string | null };
    };

    let body: RequestsBody | null = null;
    const deadline = Date.now() + 3000;
    while (body?.agent.running !== true) {
      if (Date.now() > deadline) throw new Error("embedded runner did not start");
      body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as RequestsBody;
      if (!body.agent.running) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(body.requests[0]?.status).toBe("running");
    expect(body.agent).toEqual({
      attached: false,
      running: true,
      name: "Custom",
      activity: null,
    });

    const cancelled = await fetch(`${server.url}/leglas/api/requests/cancel`, { method: "POST" });
    expect(await cancelled.json()).toEqual({ ok: true, cancelled: true });

    while (body.agent.running) {
      if (Date.now() > deadline) throw new Error("embedded runner did not cancel");
      body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as RequestsBody;
      if (body.agent.running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(body.requests[0]?.status).toBe("picked-up");

    const idle = await fetch(`${server.url}/leglas/api/requests/cancel`, { method: "POST" });
    expect(await idle.json()).toEqual({ ok: true, cancelled: false });
  });

  test("an agent counts as attached while its heartbeat is fresh, and not once it stops", async () => {
    // Only Date is faked: the server and the client are real sockets, and
    // faking their timers would stall the request this test depends on.
    const origin = await startOrigin();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const server = await start({ config: configFor(origin), port: 0 });
      const attached = async () =>
        (
          (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
            agent: { attached: boolean };
          }
        ).agent.attached;

      const beat = await fetch(`${server.url}/leglas/api/watch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watching: true }),
      });
      expect(beat.status).toBe(200);
      expect(await attached()).toBe(true);

      // One missed beat is still attached: watch beats every two seconds.
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      expect(await attached()).toBe(true);

      vi.setSystemTime(new Date("2026-01-01T00:00:07Z"));
      expect(await attached()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a watcher shutting down detaches immediately rather than aging out", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });
    const beat = (watching: boolean) =>
      fetch(`${server.url}/leglas/api/watch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watching }),
      });
    const attached = async () =>
      (
        (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
          agent: { attached: boolean };
        }
      ).agent.attached;

    await beat(true);
    expect(await attached()).toBe(true);
    await beat(false);
    expect(await attached()).toBe(false);
  });

  test("refuses a heartbeat that says nothing about watching", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const res = await fetch(`${server.url}/leglas/api/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("reports the port and url it actually bound", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${server.port}`);
  });

  test("takes the next free port when the requested one is busy", async () => {
    const blocker = net.createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", () => done()));
    const taken = (blocker.address() as AddressInfo).port;

    const server = await start({ config: configFor(await startOrigin()), port: taken });

    expect(server.port).not.toBe(taken);
    await new Promise<void>((done) => blocker.close(() => done()));
  });

  test("serves the resolved previews so the rail can render them", async () => {
    const config = configFor(await startOrigin(), [
      { title: "Wave", url: "/?v-hero=wave", note: "Client artwork", tags: ["Hero"] },
    ]);
    const server = await start({ config, port: 0 });

    const res = await fetch(`${server.url}/leglas/api/config`);
    const body = (await res.json()) as { previews: unknown[]; errors: string[] };

    expect(res.status).toBe(200);
    expect(body.previews).toHaveLength(1);
    expect(body.errors).toEqual([]);
  });

  test("a url preview registered after boot joins the config live", async () => {
    // An agent runs `leglas add` while the interface is open. The rail polls
    // this endpoint, so the direction has to appear without a restart.
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-"));
    mkdirSync(join(cwd, ".leglas"));
    const config = configFor(await startOrigin(), [{ title: "Current", url: "/" }]);
    const server = await start({ config, port: 0, cwd });

    const before = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: { title: string }[];
    };
    expect(before.previews.map((preview) => preview.title)).toEqual(["Current"]);

    writeFileSync(
      join(cwd, ".leglas/previews.json"),
      JSON.stringify({
        previews: [
          { title: "Aurora", url: "/?v-hero=aurora" },
          // A file preview needs its mount, which only boot builds, so it
          // must NOT join live and render broken.
          { title: "Paper", file: ".leglas/pages/paper.html" },
        ],
      }),
      { flag: "w" },
    );

    const after = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: { title: string; local?: boolean }[];
    };
    expect(after.previews.map((preview) => preview.title)).toEqual(["Current", "Aurora"]);
  });

  test("identifies the project, so saved layout survives a port change", async () => {
    const config = configFor(await startOrigin());
    const server = await start({ config, port: 0, project: "/work/app" });

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      project: string;
    };

    expect(body.project).toBe("/work/app");
  });

  test("serves config errors instead of dying, so the shell can show them", async () => {
    const server = await start({
      config: null,
      configErrors: ["leglas.config.ts: previews[0] needs a title."],
      port: 0,
    });

    const res = await fetch(`${server.url}/leglas/api/config`);
    const body = (await res.json()) as { previews: unknown[]; errors: string[] };

    expect(res.status).toBe(200);
    expect(body.errors[0]).toContain("needs a title");
    expect(body.previews).toEqual([]);
  });

  test("does not report stale config when the boot config is untouched", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-config-stale-"));
    writeFileSync(join(cwd, "leglas.config.json"), JSON.stringify({}));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as { errors: string[] };

    expect(body.errors).toEqual([]);
  });

  test("reports when the boot config changes, alongside existing config errors", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-config-changed-"));
    const configPath = join(cwd, "leglas.config.json");
    writeFileSync(configPath, JSON.stringify({}));
    const server = await start({
      config: configFor(await startOrigin()),
      configErrors: ["existing config error"],
      port: 0,
      cwd,
    });
    writeFileSync(configPath, JSON.stringify({ changed: true }));
    utimesSync(configPath, new Date(2020, 0, 1), new Date(2020, 0, 2));

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as { errors: string[] };

    expect(body.errors).toEqual([
      "existing config error",
      "leglas.config.json changed after Leglas started. Restart leglas to pick it up.",
    ]);
  });

  test("reports when a config appears after boot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-config-appeared-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });
    writeFileSync(join(cwd, "leglas.config.json"), JSON.stringify({}));

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as { errors: string[] };

    expect(body.errors).toContain(
      "leglas.config.json appeared after Leglas started. Restart leglas to pick it up.",
    );
  });

  test("reports when the boot config is removed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-config-removed-"));
    const configPath = join(cwd, "leglas.config.json");
    writeFileSync(configPath, JSON.stringify({}));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });
    unlinkSync(configPath);

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as { errors: string[] };

    expect(body.errors).toContain(
      "leglas.config.json was removed after Leglas started. Restart leglas to run without it.",
    );
  });

  test("reports the dev server as reachable when it is up", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const body = (await (await fetch(`${server.url}/leglas/api/health`)).json()) as {
      reachable: boolean;
    };

    expect(body.reachable).toBe(true);
  });

  test("reports the dev server as unreachable when it is down", async () => {
    const server = await start({ config: configFor(1), port: 0 });

    const body = (await (await fetch(`${server.url}/leglas/api/health`)).json()) as {
      reachable: boolean;
    };

    expect(body.reachable).toBe(false);
  });

  test("proxies any route the tool does not own", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const res = await fetch(`${server.url}/pricing`);

    expect(await res.text()).toBe("<h1>app:/pricing</h1>");
  });

  test("proxies the app root, since previews are usually relative to it", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    expect(await (await fetch(`${server.url}/`)).text()).toBe("<h1>app:/</h1>");
  });

  test("serves the shell when a built shell directory is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leglas-shell-"));
    writeFileSync(join(dir, "index.html"), "<title>shell</title>");
    const server = await start({ config: configFor(await startOrigin()), port: 0, shellDir: dir });

    const res = await fetch(`${server.url}/leglas`);

    expect(await res.text()).toContain("shell");
  });

  test("returns a 404 for an unknown shell path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leglas-shell-404-"));
    writeFileSync(join(dir, "index.html"), "<title>shell</title>");
    const server = await start({ config: configFor(await startOrigin()), port: 0, shellDir: dir });

    const res = await fetch(`${server.url}/leglas/nope.js`);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no such path");
  });

  test.each([false, true])("returns a JSON 404 for an unknown API path (shell: %s)", async (withShell) => {
    const shellDir = withShell ? mkdtempSync(join(tmpdir(), "leglas-api-404-shell-")) : null;
    if (shellDir !== null) writeFileSync(join(shellDir, "index.html"), "<title>shell</title>");
    const server = await start({ config: configFor(await startOrigin()), port: 0, shellDir });

    const res = await fetch(`${server.url}/leglas/api/state`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "No such Leglas API path." });
  });

  test("explains itself at /leglas when no shell has been built yet", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const res = await fetch(`${server.url}/leglas`);

    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("leglas");
  });

  test("closes cleanly while a live-reload socket is still open", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    await new Promise<void>((resolve) => {
      const socket = net.connect(server.port, "127.0.0.1", () => {
        socket.write(
          `GET /_next/webpack-hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
            `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        );
        resolve();
      });
      // The server destroys this socket on shutdown; without a handler the
      // reset surfaces as an unhandled exception and fails the run.
      socket.on("error", () => {});
    });

    // The assertion is that this resolves at all: an upgraded socket detaches
    // from its server, so close() hangs forever unless sockets are tracked.
    await expect(server.close()).resolves.toBeUndefined();
    running.length = 0;
  });
});
