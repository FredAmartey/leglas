import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createProxyHandler, startProxyServer } from "./proxy.js";

/** How long a wait may take before it is a hang rather than a slow machine. */
const EVENTUALLY_MS = 15_000;

/**
 * Node detaches a socket from its server once upgraded, so neither close() nor
 * closeAllConnections() will reap it and close() waits forever. Every server
 * that accepts upgrades has to track its own sockets to shut down.
 */
function shutdown(server: http.Server, sockets: Set<net.Socket>): Promise<void> {
  return new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.closeAllConnections();
    server.close(() => done());
  });
}

function trackSockets(server: http.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

/** A stand-in dev server, so proxy behaviour is tested against real HTTP. */
function startOrigin(): Promise<{ port: number; close: () => Promise<void>; seen: Request[] }> {
  const seen: Request[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers as Record<string, string> });

    if (req.url === "/redirect-absolute") {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
      return res.end();
    }
    if (req.url === "/redirect-relative") {
      res.writeHead(302, { location: "/landed" });
      return res.end();
    }
    if (req.url === "/set-cookie") {
      res.writeHead(200, { "set-cookie": ["session=abc; Path=/; HttpOnly"] });
      return res.end("ok");
    }
    if (req.url === "/echo-host") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(req.headers.host ?? "");
    }
    if (req.url === "/echo-cookie") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(req.headers.cookie ?? "(none)");
    }
    if (req.url === "/echo-method") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`${req.method}:${body}`);
      });
    }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first");
      slowClosed.push(false);
      const slot = slowClosed.length - 1;
      res.on("close", () => {
        slowClosed[slot] = true;
      });
      // Held open on purpose: the test is about who ends it.
      return;
    }
    if (req.url === "/status-418") {
      res.writeHead(418, { "content-type": "text/plain" });
      return res.end("teapot");
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>landed</h1>");
  });

  const sockets = trackSockets(server);

  // Stands in for a dev server's live-reload socket.
  server.on("upgrade", (req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.write(`upgraded:${req.url}`);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => shutdown(server, sockets),
        seen,
      });
    });
  });
}

type Request = { url: string; headers: Record<string, string> };

/** One entry per /slow request, flipped to true when the origin sees it close. */
const slowClosed: boolean[] = [];

function startProxy(targetPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createProxyHandler({ target: `http://127.0.0.1:${targetPort}` });
  const server = http.createServer((req, res) => {
    handler.request(req, res, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  server.on("upgrade", (req, socket, head) => handler.upgrade(req, socket, head));
  const sockets = trackSockets(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => shutdown(server, sockets),
      });
    });
  });
}

let origin: Awaited<ReturnType<typeof startOrigin>>;
let proxy: Awaited<ReturnType<typeof startProxy>>;

beforeAll(async () => {
  origin = await startOrigin();
  proxy = await startProxy(origin.port);
});

afterAll(async () => {
  await proxy.close();
  await origin.close();
});

describe("proxy", () => {
  /**
   * A branch's own dev server binds whatever `localhost` resolves to, which on
   * macOS is `::1`, so its origin is `http://[::1]:PORT`. `URL.hostname` keeps
   * the brackets, which is right for a Host header and wrong for a socket:
   * `getaddrinfo` answers ENOTFOUND for `[::1]` because it is not a name.
   * Every branch preview 502'd on this.
   */
  test("reaches a target that is an IPv6 literal", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("six");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "::1", () => resolve()));
    const port = (upstream.address() as AddressInfo).port;

    const handler = createProxyHandler({ target: `http://[::1]:${port}` });
    const front: http.Server = http.createServer((req, res) => {
      handler.request(req, res, `http://127.0.0.1:${(front.address() as AddressInfo).port}`);
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", () => resolve()));
    const frontPort = (front.address() as AddressInfo).port;

    try {
      const answer = await fetch(`http://127.0.0.1:${frontPort}/`);
      expect(answer.status).toBe(200);
      expect((await answer.text()).trim()).toBe("six");
    } finally {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 20_000);

  test("a branch proxy exposes activity and owns its loopback origin", async () => {
    let activity = 0;
    const branchProxy = await startProxyServer({
      target: `http://127.0.0.1:${origin.port}`,
      onActivity: () => {
        activity += 1;
      },
    });
    const response = await fetch(`${branchProxy.url}/slow`);

    expect(branchProxy.active()).toBe(true);
    expect(activity).toBeGreaterThan(0);

    await branchProxy.close();
    await response.text().catch(() => "");
    expect(branchProxy.active()).toBe(false);
    expect(activity).toBeGreaterThan(1);
  });

  test("passes a response body through unchanged", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`);

    expect(await res.text()).toBe("<h1>landed</h1>");
  });

  test("preserves the upstream status code", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/status-418`);

    expect(res.status).toBe(418);
  });

  test("keeps the share cookie from the app, and leaves the app's own cookies alone", async () => {
    const stripped = await fetch(`http://127.0.0.1:${proxy.port}/echo-cookie`, {
      headers: { cookie: "session=abc; leglas-share=secret-token; theme=dark" },
    });
    expect(await stripped.text()).toBe("session=abc; theme=dark");
    const only = await fetch(`http://127.0.0.1:${proxy.port}/echo-cookie`, {
      headers: { cookie: "leglas-share=secret-token" },
    });
    expect(await only.text()).toBe("(none)");
  });

  test("rewrites Host to the upstream, so frameworks emit correct absolute URLs", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/echo-host`);

    expect(await res.text()).toBe(`127.0.0.1:${origin.port}`);
  });

  test("forwards the method and request body", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/echo-method`, {
      method: "POST",
      body: "hello",
    });

    expect(await res.text()).toBe("POST:hello");
  });

  test("rewrites an absolute redirect so the browser stays inside the proxy", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/redirect-absolute`, {
      redirect: "manual",
    });

    expect(res.headers.get("location")).toBe(`http://127.0.0.1:${proxy.port}/landed`);
  });

  test("leaves a relative redirect alone, since it already resolves correctly", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/redirect-relative`, {
      redirect: "manual",
    });

    expect(res.headers.get("location")).toBe("/landed");
  });

  test("passes Set-Cookie through with its attributes intact", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/set-cookie`);

    expect(res.headers.getSetCookie()[0]).toContain("session=abc");
    expect(res.headers.getSetCookie()[0]).toContain("HttpOnly");
  });

  test("forwards request cookies upstream, so real auth survives the hop", async () => {
    await fetch(`http://127.0.0.1:${proxy.port}/echo-host`, {
      headers: { cookie: "session=abc" },
    });

    expect(origin.seen.at(-1)?.headers.cookie).toBe("session=abc");
  });

  test("forwards the websocket upgrade, which is what keeps live reload alive", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(
          `GET /_next/webpack-hmr HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n` +
            `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        );
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("upgraded:")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("no upgrade response"));
      }, 3000);
    });

    expect(response).toContain("101 Switching Protocols");
    expect(response).toContain("upgraded:/_next/webpack-hmr");
  });

  test("lets go of the upstream request when the browser gives up", async () => {
    // A pane unmounting mid-load, a scan frame moving on, a navigation that
    // abandons its module graph: the browser drops requests constantly. Each
    // one used to run to completion into a response nobody would read, with
    // its socket out of the pool until the dev server finished.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`);
      });
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });

    const deadline = Date.now() + EVENTUALLY_MS;
    while (!slowClosed.at(-1)) {
      if (Date.now() > deadline) throw new Error("the origin never saw the request close");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(slowClosed.at(-1)).toBe(true);
  });

  test("reports a dead upstream as 502 rather than hanging or crashing", async () => {
    const dead = await startProxy(1);
    const res = await fetch(`http://127.0.0.1:${dead.port}/`);

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("dev server");
    await dead.close();
  });
});
