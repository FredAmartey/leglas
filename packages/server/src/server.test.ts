import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveAgentChoice } from "./agents.js";
import type { LeglasConfig } from "./config.js";
import { appendRequest, readRequests } from "./requests.js";
import { isLoopbackAddress, isTrustedMutation, startServer, type RunningServer } from "./server.js";

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

function postWatchAs(server: RunningServer, host: string, origin = `http://${host}`): Promise<number> {
  const payload = JSON.stringify({ watching: true });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: "/leglas/api/watch",
        method: "POST",
        headers: {
          host,
          origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

describe("startServer", () => {
  test.each([
    "studio.local",
    "192.168.40.12",
    "10.20.30.40",
    "172.16.0.1",
    "172.31.255.254",
    "[::1]",
  ])("allows the machine's own browser under the LAN host %s", async (hostname) => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });
    const host = `${hostname}:${server.port}`;

    expect(await postWatchAs(server, host)).toBe(200);
  });

  test("refuses a public hostname even when Origin matches it", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });
    const host = `preview.example.com:${server.port}`;

    expect(await postWatchAs(server, host)).toBe(403);
  });

  test("still refuses a mismatched Origin on an allowed LAN hostname", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    expect(
      await postWatchAs(
        server,
        `studio.local:${server.port}`,
        `http://192.168.40.12:${server.port}`,
      ),
    ).toBe(403);
  });

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
      startedAt: null,
    });
    expect(existsSync(join(cwd, ".leglas"))).toBe(false);
  });

  test("reports available agents and round-trips the saved choice", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-api-"));
    // Injected so the test never spawns real vendor CLIs to ask about logins.
    let probes = 0;
    const server = await start({
      config: configFor(await startOrigin()),
      port: 0,
      cwd,
      detect: async () => {
        probes += 1;
        return [
          { id: "claude", name: "Claude", available: true, auth: "ok" },
          { id: "codex", name: "Codex", available: true, auth: "signed-out" },
          { id: "cursor", name: "Cursor", available: false, auth: "unknown" },
        ];
      },
    });

    const initial = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: { id: string; name: string; available: boolean; auth: string }[];
      choice: string | null;
      customRun: string | null;
    };
    expect(initial.agents).toEqual([
      { id: "claude", name: "Claude", available: true, auth: "ok" },
      { id: "codex", name: "Codex", available: true, auth: "signed-out" },
      { id: "cursor", name: "Cursor", available: false, auth: "unknown" },
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
    // Three reads, one probe: the login answer is served from the cache.
    expect(probes).toBe(1);
  });

  test.each([
    { agent: "unknown" },
    { agent: "custom" },
    { agent: "custom", run: "node --file={prompt}" },
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
      requests: { id: string; status: string }[];
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
      startedAt: expect.any(Number),
    });

    // Naming a request that is not the running one is a refusal, not a stop.
    const mismatched = await fetch(`${server.url}/leglas/api/requests/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "not-this-one" }),
    });
    expect(await mismatched.json()).toEqual({ ok: true, cancelled: false });

    const cancelled = await fetch(`${server.url}/leglas/api/requests/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.requests[0]?.id }),
    });
    expect(await cancelled.json()).toEqual({ ok: true, cancelled: true });

    while (body.agent.running) {
      if (Date.now() > deadline) throw new Error("embedded runner did not cancel");
      body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as RequestsBody;
      if (body.agent.running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(body.requests[0]?.status).toBe("failed");

    const idle = await fetch(`${server.url}/leglas/api/requests/cancel`, { method: "POST" });
    expect(await idle.json()).toEqual({ ok: true, cancelled: false });
  });

  test("replaces a failed request with a fresh queued copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-retry-api-"));
    await saveAgentChoice(cwd, {
      agent: "custom",
      run: 'node -e "process.exit(7)" {prompt}',
    });
    await appendRequest(cwd, {
      title: "Aurora",
      url: "/?v-hero=aurora",
      intent: "warmer",
      target: ".leglas/variants/hero/aurora.tsx",
      prompt: "make it warmer",
    });
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    let failed: { id: string; status: string } | undefined;
    const deadline = Date.now() + 3000;
    while (failed?.status !== "failed") {
      if (Date.now() > deadline) throw new Error("embedded runner did not report failure");
      const payload = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
        requests: { id: string; status: string }[];
      };
      failed = payload.requests[0];
      if (failed?.status !== "failed") await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const response = await fetch(`${server.url}/leglas/api/requests/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: failed.id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [retried] = await readRequests(cwd);
    expect(retried).toMatchObject({
      status: "queued",
      title: "Aurora",
      url: "/?v-hero=aurora",
      intent: "warmer",
      target: ".leglas/variants/hero/aurora.tsx",
      prompt: "make it warmer",
    });
    expect(retried?.id).not.toBe(failed.id);
  });

  test("refuses to retry a request that has not failed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-retry-pending-"));
    await appendRequest(cwd, {
      title: "Aurora",
      url: "/",
      intent: "warmer",
      target: null,
      prompt: "make it warmer",
    });
    const [queued] = await readRequests(cwd);
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/requests/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: queued?.id }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  test("returns 404 when retry names no request", async () => {
    const server = await start({ config: configFor(await startOrigin()), port: 0 });

    const response = await fetch(`${server.url}/leglas/api/requests/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  test("dismisses a failed request out of the queue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "leglas-dismiss-api-"));
    await saveAgentChoice(cwd, {
      agent: "custom",
      run: 'node -e "process.exit(7)" {prompt}',
    });
    await appendRequest(cwd, {
      title: "Aurora",
      url: "/",
      intent: "warmer",
      target: null,
      prompt: "make it warmer",
    });
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    let failed: { id: string; status: string } | undefined;
    const deadline = Date.now() + 3000;
    while (failed?.status !== "failed") {
      if (Date.now() > deadline) throw new Error("embedded runner did not report failure");
      const payload = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
        requests: { id: string; status: string }[];
      };
      failed = payload.requests[0];
      if (failed?.status !== "failed") await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const response = await fetch(`${server.url}/leglas/api/requests/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: failed.id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await readRequests(cwd)).toEqual([]);
  });

  test("refuses to dismiss a request that has not failed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-dismiss-pending-"));
    await appendRequest(cwd, {
      title: "Aurora",
      url: "/",
      intent: "warmer",
      target: null,
      prompt: "make it warmer",
    });
    const [queued] = await readRequests(cwd);
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/requests/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: queued?.id }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await readRequests(cwd)).toHaveLength(1);
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

  test("permanently deletes local previews through the interface API", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-delete-preview-"));
    mkdirSync(join(cwd, ".leglas"));
    writeFileSync(
      join(cwd, ".leglas/previews.json"),
      JSON.stringify({ previews: [{ title: "Aurora", url: "/?v-hero=aurora" }] }),
    );
    // Local previews are part of the boot config in a real Leglas process.
    // The endpoint must still remove one from the live payload immediately.
    const config = configFor(await startOrigin(), [
      { title: "Current", url: "/" },
      { title: "Aurora", url: "/?v-hero=aurora", local: true },
    ]);
    const server = await start({ config, port: 0, cwd });

    const deleted = await fetch(`${server.url}/leglas/api/previews/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titles: ["Aurora"] }),
    });
    const payload = (await deleted.json()) as { deleted: number; ok: boolean };

    expect(deleted.status).toBe(200);
    expect(payload).toEqual({ deleted: 1, ok: true });
    const after = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: { title: string }[];
    };
    expect(after.previews.map((preview) => preview.title)).toEqual(["Current"]);
  });

  test("refuses to rewrite shared config previews through permanent delete", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-delete-shared-preview-"));
    const config = configFor(await startOrigin(), [{ title: "Current", url: "/" }]);
    const server = await start({ config, port: 0, cwd });

    const deleted = await fetch(`${server.url}/leglas/api/previews/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titles: ["Current"] }),
    });

    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toMatchObject({ ok: false });
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

describe("mutation trust", () => {
  const request = (headers: Record<string, string>, peer: string | undefined) =>
    ({ headers, socket: { remoteAddress: peer } }) as unknown as http.IncomingMessage;

  test("an origin-less request is trusted only from the machine itself", () => {
    expect(isTrustedMutation(request({ host: "localhost:4100" }, "127.0.0.1"))).toBe(true);
    expect(isTrustedMutation(request({ host: "localhost:4100" }, "::ffff:127.0.0.1"))).toBe(true);
    // The finding this closes: a curl from across the LAN sends no Origin,
    // and before the runner existed the worst it could do was queue text.
    expect(isTrustedMutation(request({ host: "192.168.1.20:4100" }, "192.168.1.44"))).toBe(false);
    expect(isTrustedMutation(request({ host: "fred.local:4100" }, "192.168.1.44"))).toBe(false);
  });

  test("a forged Origin does not make a network peer a browser", () => {
    // Origin is browser-enforced, which means a raw client writes whatever it
    // wants there. Matching headers from a non-loopback socket prove nothing,
    // so the socket decides and the headers only ever narrow further.
    expect(
      isTrustedMutation(
        request(
          { host: "192.168.1.20:4100", origin: "http://192.168.1.20:4100" },
          "192.168.1.44",
        ),
      ),
    ).toBe(false);
    expect(
      isTrustedMutation(
        request({ host: "studio.local:4100", origin: "http://studio.local:4100" }, "192.168.1.44"),
      ),
    ).toBe(false);
  });

  test("the machine's own browser passes with a LAN hostname in the bar", () => {
    expect(
      isTrustedMutation(
        request({ host: "studio.local:4100", origin: "http://studio.local:4100" }, "127.0.0.1"),
      ),
    ).toBe(true);
  });

  test("cross-origin and public hosts stay refused regardless of peer", () => {
    expect(
      isTrustedMutation(
        request({ host: "localhost:4100", origin: "http://evil.example.com" }, "127.0.0.1"),
      ),
    ).toBe(false);
    expect(
      isTrustedMutation(
        request({ host: "evil.example.com", origin: "http://evil.example.com" }, "127.0.0.1"),
      ),
    ).toBe(false);
  });

  test("loopback recognition covers the shapes Node reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.44")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
