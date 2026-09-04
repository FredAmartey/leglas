import http from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveAgentChoice } from "./agents.js";
import { CAPTURES_DIR, REFERENCES_DIR } from "./attachments.js";
import { NO_BROWSER, type Browser, type BrowserPool, type CdpPage } from "./browser.js";
import type { ClaudeTurnRunner } from "./claude-agent-session.js";
import type { LeglasConfig } from "./config.js";
import type { LiveChange, LiveHub } from "./live.js";
import { appendRequest, markFailed, readRequests } from "./requests.js";
import { isLoopbackAddress, isTrustedMutation, startServer, type RunningServer } from "./server.js";
import { SERVER_INFO_PATH } from "./server-info.js";
import { startTunnel as startTunnelProcess } from "./tunnel.js";
import type { RunningWorktree } from "./worktree.js";

const running: RunningServer[] = [];
const origins: http.Server[] = [];
const TWO_BY_THREE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAC0lEQVR4nGNgwAkAABsAAco8Sg0AAAAASUVORK5CYII=",
  "base64",
);

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

type FakeLiveHub = LiveHub & {
  readonly changes: LiveChange[];
  setListening(value: number): void;
  close: ReturnType<typeof vi.fn>;
};

function fakeLiveHub(initialListening = 0): FakeLiveHub {
  let listening = initialListening;
  const changes: LiveChange[] = [];
  return {
    changes,
    nudge: (change) => changes.push(change),
    upgrade: () => false,
    close: vi.fn(async () => {}),
    get listening() {
      return listening;
    },
    get viewers() {
      return 0;
    },
    setListening: (value) => {
      listening = value;
    },
  };
}

/** How long a wait may take before it is a hang rather than a slow machine. */
const EVENTUALLY_MS = 15_000;

/**
 * The deadline bounds a hang. It is not an assertion about latency.
 *
 * Two different tests failed here on a loaded machine, both with "condition
 * never held", both waiting on something the operating system delivers when it
 * gets to it: a filesystem watch event, a reachability probe. A suite that
 * reports a slow machine as a defect teaches people to rerun until it passes,
 * which is how a real failure gets waved through.
 *
 * Fifteen seconds costs nothing on every run where the condition holds, and
 * the config's own ceiling sits above it so this message wins the race.
 */
const eventually = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + EVENTUALLY_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function expectConditionalRead(url: string, change: () => Promise<void> | void): Promise<void> {
  const initial = await fetch(url);
  const initialBody = await initial.text();
  const initialEtag = initial.headers.get("etag");

  expect(initial.status).toBe(200);
  expect(initialEtag).toBe(
    `"${createHash("sha256").update(initialBody).digest("base64url")}"`,
  );

  const unchanged = await fetch(url, { headers: { "if-none-match": initialEtag ?? "" } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("etag")).toBe(initialEtag);
  expect(await unchanged.text()).toBe("");

  await change();

  const changed = await fetch(url, { headers: { "if-none-match": initialEtag ?? "" } });
  const changedBody = await changed.text();
  const changedEtag = changed.headers.get("etag");
  expect(changed.status).toBe(200);
  expect(changedBody).not.toBe(initialBody);
  expect(changedEtag).not.toBe(initialEtag);
  expect(changedEtag).toBe(
    `"${createHash("sha256").update(changedBody).digest("base64url")}"`,
  );

  const changedUnchanged = await fetch(url, {
    headers: { "if-none-match": changedEtag ?? "" },
  });
  expect(changedUnchanged.status).toBe(304);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

async function start(options: Parameters<typeof startServer>[0]): Promise<RunningServer> {
  // Server tests exercise HTTP behavior, not the installed Codex binary.
  const server = await startServer({
    codexAppServer: null,
    claudeAgentSession: null,
    detectTunnels: async () => [],
    pool: quietPool(),
    ...options,
  });
  running.push(server);
  return server;
}

function quietPool(reason = NO_BROWSER): BrowserPool {
  return {
    acquire: async () => null,
    reason: () => reason,
    close: async () => {},
  };
}

function capturePool(loads = true): BrowserPool {
  const listeners = new Map<string, Set<(params: any) => void>>();
  const page: CdpPage = {
    on: (method, listener) => {
      const group = listeners.get(method) ?? new Set();
      group.add(listener);
      listeners.set(method, group);
      return () => group.delete(listener);
    },
    send: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      if (method === "Page.navigate") {
        if (loads) {
          queueMicrotask(() => {
            for (const listener of listeners.get("Page.loadEventFired") ?? []) listener({});
          });
        }
      }
      if (method === "Page.getLayoutMetrics") {
        const width = Number((params as { width?: number }).width) || 390;
        return { cssContentSize: { width, height: 600 } } as T;
      }
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("fake png").toString("base64") } as T;
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: null } } as T;
      }
      return {} as T;
    },
  };
  const browser: Browser = {
    closed: false,
    close: async () => {},
    withPage: async (work) => work(page),
  };
  return { acquire: async () => browser, reason: () => null, close: async () => {} };
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

function referenceFiles(cwd: string): string[] {
  const directory = join(cwd, REFERENCES_DIR);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function postRawReference(
  server: RunningServer,
  headers: http.OutgoingHttpHeaders,
  chunks: readonly Buffer[] | null,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: "/leglas/api/references",
        method: "POST",
        headers,
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (chunk: Buffer) => parts.push(chunk));
        response.once("end", () => {
          settled = true;
          if (!request.writableEnded) request.destroy();
          const text = Buffer.concat(parts).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    if (chunks === null) {
      request.flushHeaders();
      return;
    }
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

const shareLayout = (compare: string | null = null) => ({
  order: ["Current", "Aurora", "Paper"],
  renames: { Aurora: "Afterglow" },
  collapsedFamilies: [],
  compare,
  viewport: 390,
});

function postShare(
  server: RunningServer,
  body: Record<string, unknown>,
  suffix = "",
): Promise<Response> {
  return fetch(`${server.url}/leglas/api/share${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function enterShare(localUrl: string): Promise<string> {
  const response = await fetch(localUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/leglas/");
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function openViewerSocket(
  port: number,
  cookie: string,
  extraHeaders = "",
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("share websocket did not upgrade"));
    }, 2000);
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("latin1");
      if (!answer.includes("\r\n\r\n")) return;
      clearTimeout(deadline);
      if (!answer.startsWith("HTTP/1.1 101")) {
        socket.destroy();
        reject(new Error(`share websocket answered ${answer.split("\r\n", 1)[0] ?? "nothing"}`));
        return;
      }
      resolve(socket);
    });
    socket.once("connect", () => {
      socket.write(
        `GET /leglas/api/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Cookie: ${cookie}\r\n${extraHeaders}Connection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      );
    });
  });
}

class ShareTunnelChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number> = [];

  kill = (signal?: NodeJS.Signals | number): boolean => {
    this.signals.push(signal ?? "SIGTERM");
    queueMicrotask(() => this.emit("exit", null, signal ?? null));
    return true;
  };
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
    const first = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as { requests: { id: string; status: string; intent: string; mode: string }[] };
    // The mode travels with the status: a fork leaves its parent's document
    // alone, and the interface needs to know that to leave the parent's
    // duplicate verdict alone too.
    expect(first.requests).toMatchObject([{ id: expect.any(String), status: "queued", intent: "warmer", mode: "variant" }]);
    const second = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as typeof first;
    expect(second).toEqual(first);
  });

  test("uploads a PNG reference with its measured dimensions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-upload-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: TWO_BY_THREE_PNG,
    });
    const body = (await response.json()) as {
      ok: boolean;
      reference: {
        id: string;
        file: string;
        name: string;
        width: number;
        height: number;
        bytes: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      reference: {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
        file: expect.stringMatching(/^\.leglas\/references\/[A-Za-z0-9_-]+\.png$/),
        name: "image",
        width: 2,
        height: 3,
        bytes: 68,
      },
    });
    expect(readFileSync(join(cwd, body.reference.file))).toEqual(TWO_BY_THREE_PNG);
  });

  test("refuses a non-image reference without writing it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-type-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "not an image",
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Only PNG, JPEG, WebP and GIF images can be attached.",
    });
    expect(referenceFiles(cwd)).toEqual([]);
  });

  test("refuses a declared reference over 10MB before reading it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-length-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await postRawReference(
      server,
      { "content-length": "10000001" },
      null,
    );

    expect(response).toEqual({
      status: 413,
      body: { ok: false, error: "That image is over 10MB." },
    });
    expect(referenceFiles(cwd)).toEqual([]);
  });

  test("stops a streamed reference as soon as it passes 10MB", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-stream-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await postRawReference(
      server,
      {},
      [Buffer.alloc(5_000_000), Buffer.alloc(5_000_001)],
    );

    expect(response).toEqual({
      status: 413,
      body: { ok: false, error: "That image is over 10MB." },
    });
    expect(referenceFiles(cwd)).toEqual([]);
  });

  test("moves an uploaded reference into the request capture directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-request-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      port: 0,
      cwd,
    });
    const uploaded = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      body: TWO_BY_THREE_PNG,
    });
    const uploadedBody = (await uploaded.json()) as {
      reference: { id: string; file: string };
    };

    const response = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Poster",
        intent: "use the attached proportions",
        references: [uploadedBody.reference.id],
      }),
    });
    const [queued] = await readRequests(cwd);

    expect(response.status).toBe(200);
    expect(queued?.attachments).toMatchObject([
      {
        kind: "reference",
        file: `.leglas/captures/${queued.id}/reference-1.png`,
        width: 2,
        height: 3,
      },
    ]);
    expect(readFileSync(join(cwd, CAPTURES_DIR, queued?.id ?? "", "reference-1.png"))).toEqual(
      TWO_BY_THREE_PNG,
    );
    expect(existsSync(join(cwd, uploadedBody.reference.file))).toBe(false);
  });

  test("sanitises the uploaded reference display name", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-name-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });
    const longName = `../caf\u00e9\\${"x".repeat(90)}.png`;

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      headers: { "x-leglas-filename": longName },
      body: TWO_BY_THREE_PNG,
    });
    const body = (await response.json()) as { reference: { name: string } };

    expect(response.status).toBe(200);
    expect(body.reference.name).toBe(`..caf${"x".repeat(75)}`);
    expect(body.reference.name).toHaveLength(80);
  });

  test("refuses an empty reference upload", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-empty-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      body: Buffer.alloc(0),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "The upload was empty." });
    expect(referenceFiles(cwd)).toEqual([]);
  });

  test("falls back to image when the reference display name has no safe characters", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-reference-name-empty-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      headers: { "x-leglas-filename": "\u00e9/\\" },
      body: TWO_BY_THREE_PNG,
    });
    const body = (await response.json()) as { reference: { name: string } };

    expect(response.status).toBe(200);
    expect(body.reference.name).toBe("image");
  });

  test("a request moves attached references and records why a browser capture was skipped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-captures-"));
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(200, 20);
    writeFileSync(join(cwd, REFERENCES_DIR, "paste_1.png"), png);
    const server = await start({
      config: configFor(await startOrigin(), [
        { title: "Poster", url: "/" },
        { title: "Ledger", url: "/ledger" },
      ]),
      port: 0,
      cwd,
    });

    const response = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Poster",
        intent: "warmer",
        width: 390,
        compare: "Ledger",
        references: ["paste_1"],
      }),
    });
    const body = (await response.json()) as {
      attachments: { kind: string; file: string }[];
      prompt: string;
    };

    expect(response.status).toBe(200);
    expect(body.attachments).toMatchObject([
      { kind: "reference", file: expect.stringContaining("reference-1.png") },
    ]);
    expect(body.prompt).toContain("Reference images the user attached");
    expect(body.prompt).toContain(NO_BROWSER);
    const [queued] = await readRequests(cwd);
    expect(queued?.attachments).toEqual(body.attachments);
    expect(queued?.captureNote).toBe(NO_BROWSER);
    expect(existsSync(join(cwd, REFERENCES_DIR, "paste_1.png"))).toBe(false);
  });

  test("rejects malformed reference ids before moving or queueing anything", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-reference-id-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      port: 0,
      cwd,
    });

    const response = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster", intent: "warmer", references: ["../secret"] }),
    });

    expect(response.status).toBe(400);
    expect(await readRequests(cwd)).toEqual([]);
  });

  test("captures a direction through the shared browser pool", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-api-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster Print!", url: "/" }]),
      pool: capturePool(),
      port: 0,
      cwd,
    });

    const response = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster Print!", width: 390 }),
    });
    const body = (await response.json()) as {
      file: string;
      width: number;
      height: number;
      viewport: number;
      errors: string[];
      hydration: null;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      file: ".leglas/captures/show/poster-print-390.png",
      width: 390,
      height: 600,
      viewport: 390,
      errors: [],
      hydration: null,
    });
    expect(readFileSync(join(cwd, body.file), "utf8")).toBe("fake png");
  });

  test("captures one note crop and names it in the show file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-note-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      pool: capturePool(),
      port: 0,
      cwd,
    });
    const noteResponse = await fetch(`${server.url}/leglas/api/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Poster",
        note: "crop here",
        anchor: {
          selector: "#missing",
          text: "Body",
          tag: "p",
          classes: [],
          rect: { x: 10, y: 20, width: 40, height: 30 },
          viewport: 390,
        },
      }),
    });
    const note = (await noteResponse.json()) as { annotation: { id: string } };

    const response = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster", width: 390, note: note.annotation.id }),
    });
    const body = (await response.json()) as { file: string; width: number; height: number };

    expect(response.status).toBe(200);
    expect(body.file).toBe(
      `.leglas/captures/show/poster-390-${note.annotation.id}.png`,
    );
    expect(body.width).toBe(640);
    expect(body.height).toBe(400);
  });

  test("capture gives a bounded timeout when the page never loads", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-timeout-"));
    const nativeSetTimeout = globalThis.setTimeout;
    // The deadline fires first here; the load's own share is left real, so
    // this is the abandonment path and nothing else.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
        nativeSetTimeout(callback, milliseconds === 15_000 ? 5 : milliseconds, ...args)) as typeof setTimeout,
    );
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      pool: capturePool(false),
      port: 0,
      cwd,
    });

    const response = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster" }),
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The page did not load in time.",
    });
  });

  test("a page that rendered but never fired load is still captured", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-stalled-"));
    const nativeSetTimeout = globalThis.setTimeout;
    // The load's share of the deadline lapses at once; the deadline itself
    // stays real, so the capture that follows has all the time it needs.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
        nativeSetTimeout(callback, milliseconds === 9_000 ? 5 : milliseconds, ...args)) as typeof setTimeout,
    );
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      pool: capturePool(false),
      port: 0,
      cwd,
    });

    const response = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: string };
    expect(existsSync(join(cwd, body.file))).toBe(true);
  });

  test("an upload lets go of references pasted an hour ago and never sent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-references-prune-"));
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    const stale = join(cwd, REFERENCES_DIR, "stale.png");
    writeFileSync(stale, TWO_BY_THREE_PNG);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/references`, {
      method: "POST",
      body: TWO_BY_THREE_PNG,
    });
    expect(response.status).toBe(200);
    // The prune runs off the response; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(cwd, REFERENCES_DIR))).toHaveLength(1);
  });

  test("capture reports unknown directions and unavailable browsers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-errors-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      port: 0,
      cwd,
    });
    const send = (title: string) =>
      fetch(`${server.url}/leglas/api/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });

    expect((await send("Missing")).status).toBe(404);
    const unavailable = await send("Poster");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, error: NO_BROWSER });
  });

  test("keeps a note, hands it back, and forgets it on request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-api-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });
    const anchor = {
      classes: ["pouch"],
      rect: { height: 220, width: 340, x: 512, y: 180 },
      selector: "main > div:nth-of-type(2)",
      tag: "div",
      text: "Made in Ghana",
      viewport: 1440,
    };

    const kept = await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({ anchor, note: "looks fake", title: "Poster" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(kept.status).toBe(200);
    const { annotation } = (await kept.json()) as { annotation: { id: string } };

    const listed = (await (
      await fetch(`${server.url}/leglas/api/annotations`)
    ).json()) as { annotations: { note: string }[] };
    expect(listed.annotations).toMatchObject([{ note: "looks fake", title: "Poster" }]);

    const forgotten = await fetch(`${server.url}/leglas/api/annotations/delete`, {
      body: JSON.stringify({ ids: [annotation.id] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(await forgotten.json()).toMatchObject({ deleted: 1, ok: true });
  });

  test("rewords a note that is already there", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-reword-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });

    const kept = await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({
        anchor: {
          classes: ["pouch"],
          rect: { height: 220, width: 340, x: 512, y: 180 },
          selector: "main > div:nth-of-type(2)",
          tag: "div",
          text: "Made in Ghana",
          viewport: 1440,
        },
        note: "looks fake",
        title: "Poster",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { annotation } = (await kept.json()) as { annotation: { id: string } };

    const revised = await fetch(`${server.url}/leglas/api/annotations/update`, {
      body: JSON.stringify({ id: annotation.id, note: "looks printed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(revised.status).toBe(200);
    const { annotation: reworded } = (await revised.json()) as {
      annotation: { id: string; note: string };
    };
    expect(reworded.note).toBe("looks printed");
    // Reissued, so a change already holding the old id cannot sweep this.
    expect(reworded.id).not.toBe(annotation.id);

    const listed = (await (
      await fetch(`${server.url}/leglas/api/annotations`)
    ).json()) as { annotations: { note: string }[] };
    expect(listed.annotations).toMatchObject([{ note: "looks printed", title: "Poster" }]);

    const gone = await fetch(`${server.url}/leglas/api/annotations/update`, {
      body: JSON.stringify({ id: "never-existed", note: "looks printed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(gone.status).toBe(404);

    // JSON that is not an object at all. Reading a field off null throws
    // inside a listener nothing is awaiting, which takes the process with it.
    for (const nonsense of ["null", '"a string"', "[]", "7"]) {
      const refused = await fetch(`${server.url}/leglas/api/annotations/update`, {
        body: nonsense,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(refused.status).toBe(400);
    }
    // Still answering, which is the point.
    expect((await fetch(`${server.url}/leglas/api/annotations`)).status).toBe(200);

    // A body that forgot to say anything must not be read as "say nothing".
    const wordless = await fetch(`${server.url}/leglas/api/annotations/update`, {
      body: JSON.stringify({ id: reworded.id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(wordless.status).toBe(400);

    const survived = (await (
      await fetch(`${server.url}/leglas/api/annotations`)
    ).json()) as { annotations: { note: string }[] };
    expect(survived.annotations).toMatchObject([{ note: "looks printed" }]);
  });

  // The pins have to be tellable apart from the ones nobody has read yet, and
  // the queue is the only record of which is which.
  test("the queue says which notes each change answers", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-sent-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });

    const kept = await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({
        anchor: {
          classes: [],
          rect: { height: 20, width: 20, x: 0, y: 0 },
          selector: "h1",
          tag: "h1",
          text: "Poster",
          viewport: 1440,
        },
        note: "looks fake",
        title: "Poster",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { annotation } = (await kept.json()) as { annotation: { id: string } };

    await fetch(`${server.url}/leglas/api/request`, {
      body: JSON.stringify({ title: "Poster", intent: "" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const queue = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: { notes: string[] }[];
    };
    expect(queue.requests).toMatchObject([{ notes: [annotation.id] }]);

    // Rewording a note the queue is holding hands it a new identity, so the
    // change that was sent with the old words cannot take the new ones with
    // it when it lands and forgets what it answered.
    const revised = await fetch(`${server.url}/leglas/api/annotations/update`, {
      body: JSON.stringify({ id: annotation.id, note: "looks printed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { annotation: after } = (await revised.json()) as {
      annotation: { id: string; note: string };
    };
    expect(after.note).toBe("looks printed");
    expect(after.id).not.toBe(annotation.id);
  });

  test("refuses a note with nothing to point at", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-anchor-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });

    const posted = await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({ note: "looks fake", title: "Poster" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(posted.status).toBe(400);
  });

  // The pins carry their own words and their own address, so the composer is
  // allowed to be empty. This is the whole point of leaving them.
  test("a change with notes and no words is still a request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-request-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });
    await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({
        anchor: {
          classes: [],
          rect: { height: 20, width: 40, x: 1, y: 2 },
          selector: "h1",
          tag: "h1",
          text: "Tropical",
          viewport: 1440,
        },
        note: "too tight",
        title: "Poster",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const posted = await fetch(`${server.url}/leglas/api/request`, {
      body: JSON.stringify({ title: "Poster", intent: "" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(posted.status).toBe(200);
    const { prompt } = (await posted.json()) as { prompt: string };
    expect(prompt).toContain("1. too tight");
    expect(prompt).toContain("path h1");
    expect(prompt).toContain("reading “Tropical”");
  });

  // The pins stay on a direction after a fork, so the send button can be
  // pressed twice on the same brief. That costs two provider turns for one
  // piece of work.
  test("refuses the same notes sent twice while the first is still waiting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-dup-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });
    await fetch(`${server.url}/leglas/api/annotations`, {
      body: JSON.stringify({
        anchor: {
          classes: [],
          rect: { height: 20, width: 40, x: 1, y: 2 },
          selector: "h1",
          spot: { x: 0.5, y: 0.5 },
          tag: "h1",
          text: "Tropical",
          viewport: 1440,
        },
        note: "too tight",
        title: "Poster",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const send = () =>
      fetch(`${server.url}/leglas/api/request`, {
        body: JSON.stringify({ title: "Poster", intent: "" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
  });

  test("nothing typed and nothing pinned is not a request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-note-empty-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });

    const posted = await fetch(`${server.url}/leglas/api/request`, {
      body: JSON.stringify({ title: "Poster", intent: "  " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(posted.status).toBe(400);
  });

  test("refuses a second copy of a change that is still waiting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-duplicate-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }, { title: "Hero", url: "/hero" }]),
      port: 0,
      cwd,
    });
    const send = (title: string, intent: string) =>
      fetch(`${server.url}/leglas/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, intent }),
      });

    expect((await send("Poster", "make it warmer")).status).toBe(200);

    // The same words at the same direction, which is what retyping after a
    // stop produces. Two runs of it cost two provider turns and race each
    // other over one file.
    const repeat = await send("Poster", "  make it warmer  ");
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toEqual({
      ok: false,
      duplicate: true,
      error: "That exact change to Poster is already waiting.",
    });

    // The queue itself is untouched, and everything that is not an exact
    // repeat still queues: a second change to the same direction, and the
    // same change to another one.
    expect((await send("Poster", "make it colder")).status).toBe(200);
    expect((await send("Hero", "make it warmer")).status).toBe(200);
    const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: { title: string; intent: string }[];
    };
    expect(body.requests.map((request) => `${request.title}: ${request.intent}`)).toEqual([
      "Poster: make it warmer",
      "Poster: make it colder",
      "Hero: make it warmer",
    ]);
  });

  test("a change forks the direction unless the caller asks to replace it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-mode-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/?v-hero=poster" }]),
      port: 0,
      cwd,
    });
    const send = (body: Record<string, unknown>) =>
      fetch(`${server.url}/leglas/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // No mode named. The safe half of the pair is what a missing field gets,
    // because the other half overwrites the direction being compared.
    const implied = (await (await send({ title: "Poster", intent: "warmer" })).json()) as {
      prompt: string;
      mode: string;
    };
    expect(implied.mode).toBe("variant");
    expect(implied.prompt).toContain("add a new design direction based on");

    const asked = (await (
      await send({ title: "Poster", intent: "colder", mode: "replace" })
    ).json()) as { prompt: string; mode: string };
    expect(asked.mode).toBe("replace");
    expect(asked.prompt).toContain('change only the "Poster" design direction');

    // The queue keeps which kind of change each one is, so a request that
    // outlives this process still knows what it was asked to do.
    const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: { intent: string }[];
    };
    expect(body.requests).toHaveLength(2);
  });

  test("refuses a mode it does not recognise rather than guessing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-badmode-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      port: 0,
      cwd,
    });

    const refused = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Poster", intent: "warmer", mode: "overwrite" }),
    });
    expect(refused.status).toBe(400);

    // Nothing was queued on the way to being refused.
    const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: unknown[];
    };
    expect(body.requests).toEqual([]);
  });

  test("the same words in the other mode are not a duplicate", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-modedupe-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/?v-hero=poster" }]),
      port: 0,
      cwd,
    });
    const send = (mode: string) =>
      fetch(`${server.url}/leglas/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Poster", intent: "warmer", mode }),
      });

    expect((await send("variant")).status).toBe(200);
    // Forking the direction and rewriting it are different work, so this is a
    // second request rather than a second copy of the first.
    expect((await send("replace")).status).toBe(200);
    // A genuine repeat is still refused.
    expect((await send("replace")).status).toBe(409);
  });

  test("a verdict inherited from an earlier process is still actionable", async () => {
    // Nothing ran in this server: the queue arrived carrying a request an
    // earlier process had already failed. Before verdicts were written down
    // this read as picked-up forever, with no way to rerun it or let it go.
    const cwd = mkdtempSync(join(tmpdir(), "leglas-inherited-"));
    mkdirSync(join(cwd, ".leglas"), { recursive: true });
    writeFileSync(
      join(cwd, ".leglas/requests.json"),
      JSON.stringify({
        requests: [
          {
            id: "old-1",
            status: "failed",
            title: "Poster",
            url: "/",
            intent: "warmer",
            target: null,
            prompt: "make it warmer",
            failure: { code: "provider-overloaded", message: "Claude's provider was overloaded and gave up." },
          },
        ],
      }),
    );
    const server = await start({ config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]), port: 0, cwd });

    const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
      requests: { id: string; status: string; failure: { code: string } | null }[];
    };
    expect(body.requests[0]).toMatchObject({
      status: "failed",
      failure: { code: "provider-overloaded" },
    });

    const dismissed = await fetch(`${server.url}/leglas/api/requests/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "old-1" }),
    });
    expect(await dismissed.json()).toEqual({ ok: true });
    const after = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as typeof body;
    expect(after.requests).toEqual([]);
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
      stopping: false,
      waiting: null,
    });
    // A running server always leaves its rendezvous record under .leglas.
    expect(existsSync(join(cwd, SERVER_INFO_PATH))).toBe(true);
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
          { id: "claude", name: "Claude", available: true, auth: "ok", efforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "codex", name: "Codex", available: true, auth: "signed-out", efforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "cursor", name: "Cursor", available: false, auth: "unknown", efforts: [] },
        ];
      },
    });

    const initial = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: { id: string; name: string; available: boolean; auth: string }[];
      choice: string | null;
      customRun: string | null;
      effort: string | null;
    };
    expect(initial.agents).toEqual([
      { id: "claude", name: "Claude", available: true, auth: "ok", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "codex", name: "Codex", available: true, auth: "signed-out", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "cursor", name: "Cursor", available: false, auth: "unknown", efforts: [] },
    ]);
    expect(initial.choice).toBeNull();
    expect(initial.customRun).toBeNull();
    expect(initial.effort).toBeNull();

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
      body: JSON.stringify({ agent: "codex", effort: "high" }),
    });
    const known = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as typeof initial;
    expect(known).toMatchObject({ choice: "codex", customRun, effort: "high" });
    // Three reads, one probe: the login answer is served from the cache.
    expect(probes).toBe(1);

    await fetch(`${server.url}/leglas/api/agents?refresh=1`);
    expect(probes).toBe(2);
  });

  test("warms Claude as soon as it is selected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-warm-"));
    const warm = vi.fn(async () => {});
    const claudeAgentSession: ClaudeTurnRunner = {
      warm,
      run: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    };
    const server = await start({
      config: configFor(await startOrigin()),
      port: 0,
      cwd,
      claudeAgentSession,
    });

    const response = await fetch(`${server.url}/leglas/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", effort: "high" }),
    });
    expect(response.status).toBe(200);
    expect(warm).toHaveBeenCalledOnce();
  });

  test("the composer can ask for the saved agent to be warmed", async () => {
    // Intent, not selection, is what pays for a vendor process: the shell
    // asks here when the composer takes focus, and nothing is warmed at boot.
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-warm-intent-"));
    await saveAgentChoice(cwd, { agent: "claude" });
    const warm = vi.fn(async () => {});
    const claudeAgentSession: ClaudeTurnRunner = {
      warm,
      run: async () => {
        throw new Error("not used");
      },
      release: async () => {},
      close: async () => {},
    };
    const server = await start({
      config: configFor(await startOrigin()),
      port: 0,
      cwd,
      claudeAgentSession,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warm).not.toHaveBeenCalled();

    const response = await fetch(`${server.url}/leglas/api/agents/warm`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ ok: true });
    expect(warm).toHaveBeenCalledOnce();
  });

  test("warming with nothing chosen is a harmless no-op", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-warm-none-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/agents/warm`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  test("serves stale agent state while routine authentication refreshes in the background", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-stale-"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const initial = [
      {
        id: "claude" as const,
        name: "Claude",
        available: true,
        auth: "ok" as const,
        efforts: ["low" as const],
      },
      {
        id: "codex" as const,
        name: "Codex",
        available: true,
        auth: "unknown" as const,
        efforts: ["high" as const],
      },
      {
        id: "cursor" as const,
        name: "Cursor",
        available: false,
        auth: "unknown" as const,
        efforts: [],
      },
    ];
    const refreshed = initial.map((agent) =>
      agent.id === "codex" ? { ...agent, auth: "ok" as const } : agent,
    );
    let probes = 0;
    let finishRefresh: (() => void) | null = null;
    const server = await start({
      config: configFor(await startOrigin()),
      port: 0,
      cwd,
      detect: () => {
        probes += 1;
        if (probes === 1) return Promise.resolve(initial);
        return new Promise((resolve) => {
          finishRefresh = () => resolve(refreshed);
        });
      },
    });

    const first = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: typeof initial;
    };
    expect(first.agents).toEqual(initial);

    now.mockReturnValue(31_001);
    const stale = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: typeof initial;
    };
    // The second detector is deliberately unresolved: receiving this answer
    // proves the routine request did not wait behind it.
    expect(stale.agents).toEqual(initial);
    expect(probes).toBe(2);

    expect(finishRefresh).not.toBeNull();
    finishRefresh?.();
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = (await (await fetch(`${server.url}/leglas/api/agents`)).json()) as {
      agents: typeof initial;
    };
    expect(fresh.agents).toEqual(refreshed);
    expect(probes).toBe(2);
  });

  test.each([
    { agent: "unknown" },
    { agent: "custom" },
    { agent: "custom", run: "node --file={prompt}" },
    { agent: "custom", run: "node {prompt}", effort: "high" },
    { agent: "codex", run: 42 },
    { agent: "codex", effort: "extreme" },
    { agent: "cursor", effort: "high" },
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
      requests: { id: string; status: string; failure: { code: string; message: string } | null }[];
      agent: { attached: boolean; running: boolean; name: string | null; activity: string | null };
    };

    let body: RequestsBody | null = null;
    const deadline = Date.now() + EVENTUALLY_MS;
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
      stopping: false,
      waiting: null,
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
    // A stop is its own state and says who did it, so nothing in the
    // interface can dress it up as a provider failure worth rerunning.
    expect(body.requests[0]?.status).toBe("cancelled");
    expect(body.requests[0]?.failure).toEqual({
      code: "cancelled",
      message: "You stopped this run.",
    });

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
    const deadline = Date.now() + EVENTUALLY_MS;
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

  test("a retry keeps the failed request's captures under its fresh id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-retry-captures-"));
    await appendRequest(
      cwd,
      {
        title: "Aurora",
        url: "/",
        intent: "warmer",
        target: null,
        prompt: "make it warmer\n  .leglas/captures/old-id/frame.png  the whole page",
        attachments: [
          {
            kind: "frame",
            file: ".leglas/captures/old-id/frame.png",
            width: 800,
            height: 600,
          },
        ],
      },
      "old-id",
    );
    mkdirSync(join(cwd, CAPTURES_DIR, "old-id"), { recursive: true });
    writeFileSync(join(cwd, CAPTURES_DIR, "old-id/frame.png"), "frame");
    await markFailed(cwd, "old-id", { code: "agent-error", message: "failed" });
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    const response = await fetch(`${server.url}/leglas/api/requests/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "old-id" }),
    });

    expect(response.status).toBe(200);
    const [retried] = await readRequests(cwd);
    expect(retried?.id).not.toBe("old-id");
    expect(retried?.attachments?.[0]?.file).toBe(
      `.leglas/captures/${retried?.id}/frame.png`,
    );
    expect(readFileSync(join(cwd, retried?.attachments?.[0]?.file ?? ""), "utf8")).toBe("frame");
    expect(existsSync(join(cwd, CAPTURES_DIR, "old-id"))).toBe(false);
    // Watch, a custom command and `requests --json` read the prompt as text,
    // so the paths in it have to follow the files.
    expect(retried?.prompt).toContain(`.leglas/captures/${retried?.id}/frame.png`);
    expect(retried?.prompt).not.toContain("old-id");
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
    const deadline = Date.now() + EVENTUALLY_MS;
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
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-record-"));
    const closePool = vi.fn(async () => {});
    const server = await start({
      config: configFor(await startOrigin()),
      port: 0,
      cwd,
      pool: { ...quietPool(), close: closePool },
    });

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${server.port}`);
    expect(JSON.parse(readFileSync(join(cwd, SERVER_INFO_PATH), "utf8"))).toMatchObject({
      port: server.port,
      url: server.url,
      pid: process.pid,
      startedAt: expect.any(String),
    });
    await server.close();
    expect(closePool).toHaveBeenCalledOnce();
    expect(existsSync(join(cwd, SERVER_INFO_PATH))).toBe(false);
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

  test("returns conditional config responses and changes the etag with the body", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-etag-config-"));
    mkdirSync(join(cwd, ".leglas"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    await expectConditionalRead(`${server.url}/leglas/api/config`, () => {
      writeFileSync(
        join(cwd, ".leglas/previews.json"),
        JSON.stringify({ previews: [{ title: "Fresh", url: "/fresh" }] }),
      );
    });
  });

  test("returns conditional request responses and changes the etag with the body", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-etag-requests-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    await expectConditionalRead(`${server.url}/leglas/api/requests`, async () => {
      const response = await fetch(`${server.url}/leglas/api/watch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watching: true }),
      });
      expect(response.status).toBe(200);
    });
  });

  test("returns conditional annotation responses and changes the etag with the body", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-etag-annotations-"));
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd });

    await expectConditionalRead(`${server.url}/leglas/api/annotations`, async () => {
      const response = await fetch(`${server.url}/leglas/api/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Fresh",
          note: "keep this",
          anchor: { selector: "main" },
        }),
      });
      expect(response.status).toBe(200);
    });
  });

  test("returns conditional health responses and changes the etag with the body", async () => {
    const targetPort = await startOrigin();
    const target = origins.at(-1);
    if (target === undefined) throw new Error("test origin did not start");
    const server = await start({ config: configFor(targetPort), port: 0 });

    await expectConditionalRead(`${server.url}/leglas/api/health`, async () => {
      target.closeAllConnections();
      await new Promise<void>((done) => target.close(() => done()));
      origins.splice(origins.indexOf(target), 1);
    });
  });

  test("starts a branch once in the background and withholds its url until it is ready", async () => {
    const checkout = deferred<RunningWorktree>();
    const live = fakeLiveHub();
    let starts = 0;
    const config = configFor(await startOrigin(), [
      { title: "Wave", url: "/direction", branch: "feature/wave" },
    ]);
    config.devCommand = "pnpm dev --port {port}";
    config.installCommand = "pnpm install";
    const server = await start({
      config,
      live,
      port: 0,
      startWorktree: async () => {
        starts += 1;
        return checkout.promise;
      },
    });
    live.changes.splice(0);

    const idle = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: Array<Record<string, unknown>>;
    };
    expect(idle.previews[0]).toMatchObject({ title: "Wave", state: { status: "idle" } });
    expect(Object.hasOwn(idle.previews[0] ?? {}, "url")).toBe(false);

    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(`${server.url}/leglas/api/previews/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Wave" }),
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(starts).toBe(1);
    expect(await responses[0]?.json()).toMatchObject({
      ok: true,
      state: { status: "starting", phase: "checking out" },
    });

    const whileStarting = (await (
      await fetch(`${server.url}/leglas/api/config`)
    ).json()) as { previews: Array<Record<string, unknown>> };
    expect(Object.hasOwn(whileStarting.previews[0] ?? {}, "url")).toBe(false);

    checkout.resolve({
      branch: "feature/wave",
      path: "/tmp/wave",
      port: 4312,
      url: "http://127.0.0.1:4312",
      stop: async () => {},
    });
    await eventually(async () => {
      const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
        previews: Array<{ state?: { status?: string } }>;
      };
      return body.previews[0]?.state?.status === "ready";
    });

    const ready = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: Array<Record<string, unknown>>;
    };
    expect(ready.previews[0]).toMatchObject({
      title: "Wave",
      state: { status: "ready" },
    });
    const branchUrl = new URL(String(ready.previews[0]?.url));
    expect(branchUrl.pathname).toBe("/direction");
    expect(branchUrl.port).not.toBe("4312");
    expect(live.changes).toEqual(["config", "config", "config"]);
  });

  test("validates branch start titles and the command needed to boot them", async () => {
    const config = configFor(await startOrigin(), [
      { title: "Current", url: "/" },
      { title: "Wave", url: "/direction", branch: "feature/wave" },
    ]);
    config.installCommand = "pnpm install";
    config.devCommand = undefined;
    const server = await start({ config, port: 0 });
    const post = (title: string) =>
      fetch(`${server.url}/leglas/api/previews/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });

    const unknown = await post("Missing");
    expect(unknown.status).toBe(404);

    const ordinary = await post("Current");
    expect(ordinary.status).toBe(400);
    expect(await ordinary.json()).toMatchObject({ error: expect.stringContaining("branch") });

    const noCommand = await post("Wave");
    expect(noCommand.status).toBe(400);
    expect(await noCommand.json()).toMatchObject({
      error: expect.stringMatching(/Wave.*devCommand/),
    });
  });

  test("closing the server stops a branch worktree that reached ready", async () => {
    let stops = 0;
    const config = configFor(await startOrigin(), [
      { title: "Wave", url: "/", branch: "feature/wave" },
    ]);
    config.devCommand = "pnpm dev --port {port}";
    config.installCommand = "pnpm install";
    const server = await start({
      config,
      port: 0,
      startWorktree: async () => ({
        branch: "feature/wave",
        path: "/tmp/wave",
        port: 4312,
        url: "http://127.0.0.1:4312",
        stop: async () => {
          stops += 1;
        },
      }),
    });

    await fetch(`${server.url}/leglas/api/previews/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Wave" }),
    });
    await eventually(async () => {
      const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
        previews: Array<{ state?: { status?: string } }>;
      };
      return body.previews[0]?.state?.status === "ready";
    });

    await server.close();
    expect(stops).toBe(1);
  });

  test("tells the shell when unopened preview scanning is disabled", async () => {
    const config = configFor(await startOrigin(), [{ title: "Current", url: "/", note: undefined, tags: [] }]);
    config.scanPreviews = false;
    const server = await start({ config, port: 0 });

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      scanPreviews: boolean;
    };

    expect(body.scanPreviews).toBe(false);
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

  test("keeps booted local previews in config when the local registry cannot be read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-invalid-local-config-"));
    mkdirSync(join(cwd, ".leglas"));
    const registry = join(cwd, ".leglas/previews.json");
    writeFileSync(
      registry,
      JSON.stringify({ previews: [{ title: "Aurora", url: "/?v-hero=aurora" }] }),
    );
    const config = configFor(await startOrigin(), [
      { title: "Current", url: "/" },
      { title: "Aurora", url: "/?v-hero=aurora", local: true },
    ]);
    const server = await start({ config, port: 0, cwd });
    unlinkSync(registry);
    mkdirSync(registry);

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      previews: { title: string }[];
      errors: string[];
    };

    expect(body.previews.map((preview) => preview.title)).toEqual(["Current", "Aurora"]);
    expect(body.errors).toEqual([]);
  });

  test("accepts requests for booted local previews when the local registry becomes invalid", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-invalid-local-request-"));
    mkdirSync(join(cwd, ".leglas"));
    writeFileSync(
      join(cwd, ".leglas/previews.json"),
      JSON.stringify({ previews: [{ title: "Aurora", url: "/?v-hero=aurora" }] }),
    );
    const config = configFor(await startOrigin(), [
      { title: "Aurora", url: "/?v-hero=aurora", local: true },
    ]);
    const server = await start({ config, port: 0, cwd });
    writeFileSync(join(cwd, ".leglas/previews.json"), "not json");

    const response = await fetch(`${server.url}/leglas/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Aurora", intent: "warmer" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(await readRequests(cwd)).toMatchObject([{ title: "Aurora", intent: "warmer" }]);
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

  test("serves startup warnings without treating the config as invalid", async () => {
    const server = await start({
      config: configFor(await startOrigin()),
      configWarnings: ["Port 3000 may belong to another project."],
      port: 0,
    });

    const body = (await (await fetch(`${server.url}/leglas/api/config`)).json()) as {
      errors: string[];
      warnings: string[];
    };

    expect(body.errors).toEqual([]);
    expect(body.warnings).toEqual(["Port 3000 may belong to another project."]);
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

  test("coalesces request-file writes into one requests nudge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-requests-"));
    mkdirSync(join(cwd, ".leglas"));
    const live = fakeLiveHub();
    await start({ config: configFor(await startOrigin()), port: 0, cwd, live });

    const path = join(cwd, ".leglas/requests.json");
    writeFileSync(path, '{"requests":[]}\n');
    writeFileSync(path, '{"requests":[]}\n ');

    // Only that a write reaches the wire, and only ever as "requests".
    // How many nudges two back-to-back writes produce depends on when the
    // operating system delivers the watch events, not on this code, and
    // asserting a count here measured that instead and failed on a loaded
    // machine. The coalescing itself is proven against a driven clock in
    // live.test.ts, where it is a property rather than a race.
    await eventually(() => live.changes.length >= 1);
    expect(new Set(live.changes)).toEqual(new Set(["requests"]));
  });

  test("routes annotation changes through requests, never a fourth kind", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-annotations-"));
    mkdirSync(join(cwd, ".leglas"));
    const live = fakeLiveHub();
    await start({ config: configFor(await startOrigin()), port: 0, cwd, live });

    writeFileSync(join(cwd, ".leglas/annotations.json"), '{"annotations":[]}\n');

    await eventually(() => live.changes.length === 1);
    expect(live.changes).toEqual(["requests"]);
  });

  test("nudges config when the late-created previews registry changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-previews-"));
    const live = fakeLiveHub();
    await start({ config: configFor(await startOrigin()), port: 0, cwd, live });

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(cwd, ".leglas/previews.json"), '{"previews":[]}\n');

    await eventually(() => live.changes.includes("config"));
    expect(live.changes).toEqual(["config"]);
  });

  test("nudges config when the resolved config file changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-config-"));
    const configPath = join(cwd, "leglas.config.json");
    writeFileSync(configPath, "{}\n");
    const live = fakeLiveHub();
    await start({ config: configFor(await startOrigin()), port: 0, cwd, live });

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(configPath, '{"previews":[]}\n');

    await eventually(() => live.changes.includes("config"));
    expect(live.changes).toEqual(["config"]);
  });

  test("passes runner state changes to the requests channel", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-live-runner-"));
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
    const live = fakeLiveHub();
    const server = await start({ config: configFor(await startOrigin()), port: 0, cwd, live });

    await eventually(async () => {
      const body = (await (await fetch(`${server.url}/leglas/api/requests`)).json()) as {
        agent: { running: boolean };
      };
      return body.agent.running;
    });
    expect(live.changes).toContain("requests");
  });

  test("nudges health once when reachability flips, not on steady probes", async () => {
    const nativeSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
        nativeSetInterval(callback, milliseconds === 3000 ? 10 : milliseconds, ...args)) as typeof setInterval,
    );
    const target = http.createServer();
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    origins.push(target);
    const targetPort = (target.address() as AddressInfo).port;
    const live = fakeLiveHub(1);
    await start({ config: configFor(targetPort), port: 0, live });

    // The first probe establishes the baseline and emits nothing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(live.changes).toEqual([]);

    target.closeAllConnections();
    await new Promise<void>((done) => target.close(() => done()));
    origins.splice(origins.indexOf(target), 1);
    await eventually(() => live.changes.filter((change) => change === "health").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(live.changes).toEqual(["health"]);
  });

  test("does not probe health with no live listeners", async () => {
    const nativeSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
        nativeSetInterval(callback, milliseconds === 3000 ? 10 : milliseconds, ...args)) as typeof setInterval,
    );
    let connections = 0;
    const target = http.createServer();
    target.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    origins.push(target);
    const live = fakeLiveHub(0);
    const server = await start({
      config: configFor((target.address() as AddressInfo).port),
      port: 0,
      live,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connections).toBe(0);
    expect(live.changes).toEqual([]);

    await server.close();
    expect(live.close).toHaveBeenCalledOnce();
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

  test("serves a read-only share and keeps its lifecycle on the primary listener", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-"));
    const shellDir = mkdtempSync(join(tmpdir(), "leglas-"));
    const fileDir = mkdtempSync(join(tmpdir(), "leglas-"));
    const draftDir = mkdtempSync(join(tmpdir(), "leglas-"));
    writeFileSync(join(shellDir, "index.html"), "<title>shared shell</title>");
    writeFileSync(join(fileDir, "index.html"), "<h1>paper direction</h1>");
    writeFileSync(join(fileDir, ".env"), "SECRET=1");
    writeFileSync(join(draftDir, "index.html"), "<h1>draft, not shared</h1>");
    const live = fakeLiveHub();
    const server = await start({
      config: configFor(await startOrigin(), [
        { title: "Current", url: "/" },
        { title: "Aurora", url: "/aurora" },
        { title: "Paper", url: "/leglas/files/paper/index.html", file: "paper/index.html" },
        { title: "Draft", url: "/leglas/files/draft/index.html", file: "draft/index.html" },
      ]),
      cwd,
      fileMounts: new Map([
        ["paper", fileDir],
        ["draft", draftDir],
      ]),
      live,
      port: 0,
      shellDir,
    });
    live.changes.splice(0);

    const createdResponse = await postShare(server, {
      scope: "rail",
      titles: ["Current", "Paper"],
      layout: shareLayout(),
      tunnel: "none",
    });
    const created = (await createdResponse.json()) as {
      ok: true;
      share: {
        localUrl: string;
        sharePort: number;
        tunnel: { status: string };
      };
    };
    expect(createdResponse.status).toBe(200);
    expect(created.share.sharePort).not.toBe(server.port);
    expect(created.share.localUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${created.share.sharePort}/leglas/s/[A-Za-z0-9_-]{32}$`),
    );
    expect(created.share.tunnel).toEqual({ status: "none" });

    const cookie = await enterShare(created.share.localUrl);
    const remote = `http://127.0.0.1:${created.share.sharePort}`;
    // The entry answers HEAD too, so a link checker sees a live link.
    const peek = await fetch(created.share.localUrl, { method: "HEAD", redirect: "manual" });
    expect(peek.status).toBe(302);
    const viewerConfig = (await (
      await fetch(`${remote}/leglas/api/config`, { headers: { cookie } })
    ).json()) as {
      project: string;
      devServer: string;
      previews: Array<{ title: string; url: string }>;
      errors: string[];
      warnings: string[];
      viewer: { scope: string; layout: ReturnType<typeof shareLayout> };
    };
    // Nothing that names the sharer's machine reaches a viewer: the project
    // id is normally the config's absolute path, and health names the
    // working directory and the dev server's address.
    expect(viewerConfig.project).toMatch(/^share:[0-9a-f-]{36}$/);
    expect(viewerConfig.devServer).toBe("");
    expect(JSON.stringify(viewerConfig)).not.toContain(cwd);
    expect(viewerConfig.previews.map((preview) => preview.title)).toEqual([
      "Current",
      "Paper",
    ]);
    expect(viewerConfig.previews[1]?.url).toBe("/leglas/files/paper/index.html");
    expect(viewerConfig.errors).toEqual([]);
    expect(viewerConfig.warnings).toEqual([]);
    expect(viewerConfig.viewer).toEqual({ scope: "rail", layout: shareLayout() });

    expect((await fetch(`${remote}/leglas/api/config`)).status).toBe(403);
    const mutation = await fetch(`${remote}/leglas/api/watch`, {
      method: "POST",
      headers: { cookie },
    });
    expect(mutation.status).toBe(403);
    expect(await mutation.json()).toEqual({
      ok: false,
      error: "Viewers can look, not change what runs.",
    });
    for (const path of ["requests", "agents", "annotations"]) {
      const response = await fetch(`${remote}/leglas/api/${path}`, { headers: { cookie } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Not available to viewers." });
    }
    const health = await fetch(`${remote}/leglas/api/health`, { headers: { cookie } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ reachable: true });
    expect(await (await fetch(`${remote}/leglas/`, { headers: { cookie } })).text()).toContain(
      "shared shell",
    );
    expect(await (await fetch(`${remote}/pricing`, { headers: { cookie } })).text()).toBe(
      "<h1>app:/pricing</h1>",
    );
    expect((await fetch(`${remote}/pricing`)).status).toBe(403);
    expect(
      await (await fetch(`${remote}/leglas/files/paper/index.html`, { headers: { cookie } })).text(),
    ).toContain("paper direction");
    // A mount is a whole directory keyed by a guessable slug: only the
    // mounts behind shared directions answer, and never a dotfile in one.
    expect(
      (await fetch(`${remote}/leglas/files/draft/index.html`, { headers: { cookie } })).status,
    ).toBe(403);
    expect((await fetch(`${remote}/leglas/files/paper/.env`, { headers: { cookie } })).status).toBe(
      403,
    );
    // A dev server mounts routes that act on the machine: Vite's editor
    // launcher opens a file on the sharer's computer for anyone who asks.
    // Those are refused before the proxy sees them, and so is a service
    // worker, which would outlive the share.
    for (const control of [
      "/__open-in-editor?file=src/main.tsx:1:1",
      "/__nextjs_launch-editor?file=src/main.tsx",
      "/__inspect/",
      "/__inspect/module?id=x",
      "/webpack-dev-server",
    ]) {
      const refused = await fetch(`${remote}${control}`, { headers: { cookie } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ ok: false, error: "Not available to viewers." });
    }
    expect(
      (
        await fetch(`${remote}/sw.js`, {
          headers: { cookie, "sec-fetch-dest": "serviceworker" },
        })
      ).status,
    ).toBe(403);
    // The sharer's own listener is untouched by any of it.
    expect((await fetch(`${server.url}/__open-in-editor`)).status).toBe(200);

    // An app's live-reload socket is a two-way channel into the dev server,
    // so only the interface's own socket upgrades on the share listener.
    await expect(
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(created.share.sharePort, "127.0.0.1", () => {
          socket.write(
            `GET /_next/webpack-hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n` +
              `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
          );
        });
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1")));
        socket.once("close", () => resolve("closed"));
        socket.once("error", (error) => reject(error));
      }),
    ).resolves.toBe("closed");

    const second = await postShare(server, {
      scope: "direction",
      titles: ["Current"],
      layout: shareLayout(),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      ok: false,
      error: "Stop the current share first.",
    });

    const updatedResponse = await postShare(
      server,
      { scope: "direction", titles: ["Current"], layout: shareLayout() },
      "/update",
    );
    const updated = (await updatedResponse.json()) as typeof created;
    expect(updatedResponse.status).toBe(200);
    expect(updated.share.localUrl).toBe(created.share.localUrl);
    // Viewers read the config, so an update nudges that too.
    expect(live.changes.at(-1)).toBe("config");

    const stopped = await postShare(server, {}, "/stop");
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true });
    await expect(fetch(`${remote}/leglas/`)).rejects.toThrow();
    expect(await (await fetch(`${server.url}/leglas/api/share`)).json()).toEqual({
      share: null,
      tunnels: [],
    });
    expect(live.changes.filter((change) => change === "share")).toEqual([
      "share",
      "share",
      "share",
    ]);
  });

  test("validates share titles and refuses a second active share", async () => {
    const server = await start({
      config: configFor(await startOrigin(), [
        { title: "Current", url: "/" },
        { title: "Branch", url: "/branch", branch: "feature/branch" },
      ]),
      port: 0,
    });

    const branch = await postShare(server, {
      scope: "direction",
      titles: ["Branch"],
      layout: shareLayout(),
      tunnel: "none",
    });
    expect(branch.status).toBe(400);
    expect(await branch.json()).toEqual({
      ok: false,
      error: "Branch directions can't be shared yet: Branch.",
    });

    const unknown = await postShare(server, {
      scope: "direction",
      titles: ["Missing"],
      layout: shareLayout(),
      tunnel: "none",
    });
    expect(unknown.status).toBe(400);

    expect(
      (
        await postShare(server, {
          scope: "direction",
          titles: ["Current"],
          layout: shareLayout(),
          tunnel: "none",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postShare(server, {
          scope: "direction",
          titles: ["Current"],
          layout: shareLayout(),
          tunnel: "none",
        })
      ).status,
    ).toBe(409);
  });

  test("counts only authenticated live sockets on the share listener", async () => {
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Current", url: "/" }]),
      port: 0,
    });
    const response = await postShare(server, {
      scope: "direction",
      titles: ["Current"],
      layout: shareLayout(),
      tunnel: "none",
    });
    const created = (await response.json()) as {
      share: { localUrl: string; sharePort: number };
    };
    const cookie = await enterShare(created.share.localUrl);

    await new Promise<void>((resolve) => {
      const refused = net.connect(created.share.sharePort, "127.0.0.1");
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      refused.once("error", done);
      refused.once("close", done);
      refused.once("connect", () => {
        refused.write(
          `GET /leglas/api/live HTTP/1.1\r\nHost: 127.0.0.1:${created.share.sharePort}\r\n` +
            `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        );
      });
    });
    expect(
      ((await (await fetch(`${server.url}/leglas/api/share`)).json()) as { share: { viewers: number } }).share.viewers,
    ).toBe(0);

    const viewer = await openViewerSocket(created.share.sharePort, cookie);
    await eventually(async () =>
      ((await (await fetch(`${server.url}/leglas/api/share`)).json()) as { share: { viewers: number } }).share.viewers === 1,
    );
    viewer.destroy();
    await eventually(async () =>
      ((await (await fetch(`${server.url}/leglas/api/share`)).json()) as { share: { viewers: number } }).share.viewers === 0,
    );
  });

  test("a viewer arriving settles a tunnel the probe has not seen answer", async () => {
    const child = new ShareTunnelChild();
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Current", url: "/" }]),
      port: 0,
      detectTunnels: async () => ["cloudflared"],
      startTunnel: (options) =>
        startTunnelProcess(options, { spawn, probe: async () => false }),
    });
    const created = (await (
      await postShare(server, {
        scope: "direction",
        titles: ["Current"],
        layout: shareLayout(),
        tunnel: "cloudflared",
      })
    ).json()) as { share: { localUrl: string; sharePort: number } };
    const status = async () =>
      ((await (await fetch(`${server.url}/leglas/api/share`)).json()) as {
        share: { url: string | null; tunnel: { status: string; url?: string } };
      }).share;
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.write("| https://example-share.trycloudflare.com |\n");
    await eventually(async () => (await status()).tunnel.url !== undefined);
    expect((await status()).tunnel.status).toBe("starting");

    // The sharer's own resolver may never see the name; the person who
    // opened the link is proof enough that it answers. Only through the
    // tunnel, though: the sharer opening their own local link proves nothing.
    const cookie = await enterShare(created.share.localUrl);
    const local = await openViewerSocket(created.share.sharePort, cookie);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await status()).tunnel.status).toBe("starting");
    local.destroy();
    const viewer = await openViewerSocket(
      created.share.sharePort,
      cookie,
      "X-Forwarded-For: 203.0.113.7\r\nCf-Connecting-Ip: 203.0.113.7\r\n",
    );
    await eventually(async () => (await status()).tunnel.status === "ready");
    expect((await status()).url).toMatch(
      /^https:\/\/example-share\.trycloudflare\.com\/leglas\/s\/[A-Za-z0-9_-]{32}$/,
    );
    viewer.destroy();
  });

  test("closing the primary server stops its tunnel and share listener first", async () => {
    const child = new ShareTunnelChild();
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Current", url: "/" }]),
      port: 0,
      detectTunnels: async () => ["cloudflared"],
      startTunnel: (options) =>
        startTunnelProcess(options, { spawn, probe: async () => false }),
    });
    const response = await postShare(server, {
      scope: "direction",
      titles: ["Current"],
      layout: shareLayout(),
      tunnel: "cloudflared",
    });
    const created = (await response.json()) as { share: { sharePort: number } };
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    await server.close();

    expect(child.signals).toContain("SIGTERM");
    await expect(
      fetch(`http://127.0.0.1:${created.share.sharePort}/leglas/`),
    ).rejects.toThrow();
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
    expect(isTrustedMutation(request({ host: "desk.local:4100" }, "192.168.1.44"))).toBe(false);
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

describe("what a capture may resolve", () => {
  test("a direction added from a file after boot is not captured, matching the rail", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-capture-fresh-file-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      port: 0,
      cwd,
      pool: capturePool(),
    });
    // Registered while the server runs, the way an agent does it. A file
    // needs the mount boot builds, so the rail holds it back until the
    // restart, and a capture of it would render the wrong page.
    mkdirSync(join(cwd, ".leglas"), { recursive: true });
    writeFileSync(join(cwd, "fresh.html"), "<h1>fresh</h1>");
    writeFileSync(
      join(cwd, ".leglas", "previews.json"),
      JSON.stringify({ previews: [{ title: "Fresh", file: "fresh.html" }, { title: "Live", url: "/live" }] }),
    );

    const fresh = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh" }),
    });
    expect(fresh.status).toBe(404);

    // A plain URL added the same way joins at once, as it does in the rail.
    const live = await fetch(`${server.url}/leglas/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live" }),
    });
    expect(live.status).toBe(200);
  });

  test("the same words against a different comparison or picture are not a duplicate", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-request-duplicate-context-"));
    // No browser on purpose: a repeat is a repeat of what was asked, and it
    // has to be caught whether or not the capture behind it succeeded.
    const server = await start({
      config: configFor(await startOrigin(), [
        { title: "Poster", url: "/" },
        { title: "Ledger", url: "/ledger" },
        { title: "Hero", url: "/hero" },
      ]),
      port: 0,
      cwd,
    });
    const send = (body: Record<string, unknown>) =>
      fetch(`${server.url}/leglas/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await send({ title: "Poster", intent: "like the other one", compare: "Ledger" })).status).toBe(200);
    // Exactly the same request, the retype-after-stop shape.
    expect((await send({ title: "Poster", intent: "like the other one", compare: "Ledger" })).status).toBe(409);
    // The same words meaning a different other one.
    expect((await send({ title: "Poster", intent: "like the other one", compare: "Hero" })).status).toBe(200);
    // The same words with nothing alongside.
    expect((await send({ title: "Poster", intent: "like the other one" })).status).toBe(200);
    // A picture is part of the ask too, by identity rather than by count.
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    const paste = (id: string) => writeFileSync(join(cwd, REFERENCES_DIR, `${id}.png`), TWO_BY_THREE_PNG);
    paste("r1");
    expect((await send({ title: "Poster", intent: "like this", references: ["r1"] })).status).toBe(200);
    paste("r1");
    expect((await send({ title: "Poster", intent: "like this", references: ["r1"] })).status).toBe(409);
    paste("r2");
    expect((await send({ title: "Poster", intent: "like this", references: ["r2"] })).status).toBe(200);
    // One that was pruned in the meantime refuses the send rather than
    // quietly leaving the picture out.
    const gone = await send({ title: "Poster", intent: "like that", references: ["r9"] });
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { error: string }).error).toContain("Attach it again");
    const queued = await readRequests(cwd);
    expect(queued.map((entry) => [entry.compare ?? null, entry.references ?? null])).toEqual([
      ["Ledger", null],
      ["Hero", null],
      [null, null],
      [null, ["r1"]],
      [null, ["r2"]],
    ]);
  });
});

/**
 * Every route that takes a body reads fields straight off what it parsed, and
 * `null` is valid JSON. Four characters were enough to throw inside a listener
 * whose rejection nothing was waiting for, which on Node's default terms takes
 * the process down: the interface, the queue's own writer and whatever run was
 * under way, from a client that only had to reach loopback.
 */
describe("a body that is not an object", () => {
  /**
   * The routes are read out of the server rather than listed here.
   *
   * They were listed here, and within one release a route written after the
   * list was added had the hole again: nothing failed, because the list had
   * no way of knowing it existed. A new POST route is now covered the moment
   * it is written, and a route that genuinely takes something else has to say
   * so below, where the reason is visible and the entry is one somebody has
   * to justify rather than one somebody has to remember.
   */
  const NOT_A_JSON_OBJECT: Record<string, string> = {
    "/api/references": "takes raw image bytes",
    "/api/agents/warm": "takes nothing at all",
    "/api/share/stop": "takes nothing at all",
  };

  const routes = (): string[] => {
    const source = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
    const found = [
      ...source.matchAll(
        /path === `\$\{LEGLAS_PREFIX\}(?<route>\/[^`]*)` && req\.method === "POST"/g,
      ),
    ].map((match) => match.groups?.["route"] ?? "");
    expect(found.length, "no POST routes found; the pattern above has drifted").toBeGreaterThan(5);
    return found.filter((route) => !(route in NOT_A_JSON_OBJECT));
  };

  test("is refused by every route that takes one, and none of them fall over", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-json-body-"));
    const server = await start({
      config: configFor(await startOrigin(), [{ title: "Poster", url: "/" }]),
      cwd,
      port: 0,
    });

    for (const route of routes()) {
      for (const nonsense of ["null", '"a string"', "[]", "7", "true"]) {
        const answer = await fetch(`${server.url}/leglas${route}`, {
          body: nonsense,
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(answer.status, `${route} answering ${nonsense}`).toBe(400);
      }
    }

    // Still up, which is the whole point.
    expect((await fetch(`${server.url}/leglas/api/requests`)).status).toBe(200);
  });

  // The reader exists so that no route has to remember any of this. One route
  // parsing a body by hand is how the hole came back the first time.
  test("no route reads a body without going through the one reader", () => {
    const lines = readFileSync(join(import.meta.dirname, "server.ts"), "utf8").split("\n");
    const opens = lines.findIndex((line) => line.startsWith("function jsonBody<"));
    expect(opens, "jsonBody has been renamed; this check has to follow it").toBeGreaterThan(-1);
    const closes = lines.findIndex((line, index) => index > opens && line === "}");

    const offenders = lines
      .map((line, index) => ({ at: index, line: line.trim() }))
      .filter((entry) => entry.line.includes("JSON.parse(body"))
      .filter((entry) => entry.at < opens || entry.at > closes)
      .map((entry) => `server.ts:${entry.at + 1}`);

    expect(offenders, "these should call jsonBody instead").toEqual([]);
  });
});
