import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { extname, join, normalize } from "node:path";

import type { LeglasConfig } from "./config.js";
import { findDuplicates } from "./duplicates.js";
import { createProxyHandler } from "./proxy.js";

/** Everything Leglas owns lives under this prefix; the rest belongs to the app. */
export const LEGLAS_PREFIX = "/leglas";

export const DEFAULT_PORT = 4100;

/** Ports tried before giving up, so a few stale instances do not block startup. */
const PORT_ATTEMPTS = 20;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export type ServerOptions = {
  /** Null when the config failed validation; errors are served instead. */
  config: LeglasConfig | null;
  configErrors?: string[];
  port?: number;
  /** Built shell to serve at the prefix. Null serves a placeholder instead. */
  shellDir?: string | null;
  /**
   * Stable identity for this project, used by the interface to key saved
   * layout. Without it, binding a different port would look like a different
   * project and silently lose the user's rail order and renames.
   */
  project?: string;
};

export type RunningServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Is the dev server accepting connections? A TCP probe rather than an HTTP
 * request, because a framework mid-compile may accept the socket long before
 * it answers, and "starting up" should read as reachable.
 */
function probe(target: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return resolve(false);
    }

    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const socket = net.connect(port, url.hostname);
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function serveShellFile(res: http.ServerResponse, shellDir: string, urlPath: string): boolean {
  // normalize() collapses ".." before it can escape the shell directory.
  const relative = normalize(urlPath.slice(LEGLAS_PREFIX.length)).replace(/^(\.\.[/\\])+/, "");
  // normalize("") is ".", and a bare "/leglas" or "/leglas/" both mean the root
  // document, so all three resolve to index.html.
  const isRoot = relative === "" || relative === "." || relative === "/";
  const candidate = join(shellDir, isRoot ? "index.html" : relative);

  if (!candidate.startsWith(shellDir)) return false;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;

  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(candidate).pipe(res);
  return true;
}

const PLACEHOLDER = `<!doctype html>
<meta charset="utf-8">
<title>Leglas</title>
<body style="font:14px/1.6 ui-sans-serif,system-ui;padding:3rem;max-width:34rem">
<h1 style="font-size:1rem">Leglas</h1>
<p>The server is running and proxying your app. The interface has not been
built into this install yet.</p>
<p><a href="/leglas/api/config">/leglas/api/config</a> ·
<a href="/leglas/api/health">/leglas/api/health</a></p>
</body>`;

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Bind the requested port, or the next free one. A stale instance holding 4100
 * should not stop the tool from starting; it should start and say where.
 */
async function bind(server: http.Server, requested: number): Promise<number> {
  if (requested === 0) return listen(server, 0);

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    try {
      return await listen(server, requested + attempt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(
    `No free port between ${requested} and ${requested + PORT_ATTEMPTS - 1}.`,
  );
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { config, configErrors = [], shellDir = null, project = "" } = options;
  const target = config?.devServer ?? "http://localhost:3000";
  const proxy = createProxyHandler({ target });

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    if (path === `${LEGLAS_PREFIX}/api/config`) {
      return sendJson(res, 200, {
        project,
        devServer: target,
        previews: config?.previews ?? [],
        errors: configErrors,
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/duplicates`) {
      // Fetched through this server, so relative preview URLs resolve exactly
      // as the browser resolves them in a pane.
      const origin = `http://127.0.0.1:${port}`;
      return void findDuplicates(config?.previews ?? [], async (previewUrl) => {
        const response = await fetch(`${origin}${previewUrl}`);
        return response.text();
      })
        .then((groups) => sendJson(res, 200, { groups }))
        .catch(() => sendJson(res, 200, { groups: [] }));
    }

    if (path === `${LEGLAS_PREFIX}/api/health`) {
      return void probe(target).then((reachable) =>
        sendJson(res, 200, { devServer: target, reachable }),
      );
    }

    if (path === LEGLAS_PREFIX || path.startsWith(`${LEGLAS_PREFIX}/`)) {
      if (shellDir !== null && serveShellFile(res, shellDir, path)) return;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PLACEHOLDER);
    }

    return proxy.request(req, res, `http://localhost:${port}`);
  });

  // An upgraded socket detaches from its server, so close() would otherwise
  // wait forever on any open live-reload connection.
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // The shell owns nothing that upgrades yet; everything else is the app's.
    if (path.startsWith(`${LEGLAS_PREFIX}/`)) return socket.destroy();
    proxy.upgrade(req, socket, head);
  });

  const port = await bind(server, options.port ?? DEFAULT_PORT);

  return {
    port,
    url: `http://localhost:${port}`,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
