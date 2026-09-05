import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export type ProxyOptions = {
  /** Origin of the dev server being fronted, e.g. http://localhost:3000 */
  target: string;
  /** Marks traffic which proves a caller is still using this proxy. */
  onActivity?: () => void;
  /** Tracks requests that remain open, notably dev-server HMR connections. */
  onOpen?: () => void;
  onClose?: () => void;
};

export type ProxyHandler = {
  /** `publicOrigin` is the address the browser used, needed to rewrite redirects. */
  request(req: IncomingMessage, res: ServerResponse, publicOrigin: string): void;
  /** Forwards the websocket handshake. Without this, live reload dies silently. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
};

export type RunningProxy = {
  /** Whether a request or upgraded connection is still open through the proxy. */
  active(): boolean;
  close(): Promise<void>;
  url: string;
};

export const SHARE_COOKIE = "leglas-share";

/** The Cookie header without the share token, or undefined when nothing is left. */
export function withoutShareCookie(
  cookie: string | string[] | undefined,
): string | undefined {
  if (cookie === undefined) return undefined;
  const kept = (Array.isArray(cookie) ? cookie.join("; ") : cookie)
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.startsWith(`${SHARE_COOKIE}=`));
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * The proxy has one job: be invisible. If an app behaves differently through
 * Leglas than on its own port, the previews are not the real thing and the
 * tool has no reason to exist.
 */
export function createProxyHandler(options: ProxyOptions): ProxyHandler {
  const target = new URL(options.target);
  const host = target.hostname;
  /**
   * The same address, dialable.
   *
   * `URL.hostname` returns an IPv6 literal with its brackets, which is what a
   * Host header and an origin want and what a socket cannot use: `net.connect`
   * and `http.request` hand it to `getaddrinfo`, which answers ENOTFOUND for
   * `[::1]` because that is not a name. A branch's own dev server is reached
   * this way whenever it binds IPv6, which Vite does by default on macOS.
   */
  const dialHost = host.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const authority = target.port ? `${host}:${target.port}` : host;

  /**
   * Frameworks build absolute URLs from the Host header. Left as the Leglas
   * origin, they would generate links pointing back at the proxy for routes
   * only the dev server knows about.
   */
  function upstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
    const headers = { ...req.headers, host: authority } as Record<string, string | string[]>;
    // The share cookie is the one credential a viewer holds, and the app
    // being previewed has no use for it: its logs, error reporters and
    // middleware are exactly where a token should not end up.
    const cookie = withoutShareCookie(headers.cookie);
    if (cookie === undefined) delete headers.cookie;
    else headers.cookie = cookie;
    return headers;
  }

  /**
   * Only rewrite a redirect that names the upstream. A relative Location
   * already resolves against the proxy origin, and an unrelated absolute URL
   * (an OAuth provider, say) must be left alone.
   */
  function rewriteLocation(location: string | undefined, publicOrigin: string): string | undefined {
    if (location === undefined) return undefined;
    for (const origin of [`${target.protocol}//${authority}`, `${target.protocol}//localhost:${port}`]) {
      if (location.startsWith(origin)) return publicOrigin + location.slice(origin.length);
    }
    return location;
  }

  return {
    request(req, res, publicOrigin) {
      options.onActivity?.();
      options.onOpen?.();
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        options.onActivity?.();
        options.onClose?.();
      };
      res.once("finish", close);
      res.once("close", close);

      const upstream = http.request(
        { host: dialHost, port, method: req.method, path: req.url, headers: upstreamHeaders(req) },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers };
          const location = rewriteLocation(
            typeof headers.location === "string" ? headers.location : undefined,
            publicOrigin,
          );
          if (location !== undefined) headers.location = location;

          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          // Piped, never buffered: streamed responses have to stay streamed.
          upstreamRes.pipe(res);
        },
      );

      upstream.on("error", (error) => {
        if (res.headersSent || res.destroyed) return res.destroy();
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(
          `Leglas could not reach the dev server at ${options.target} (${error.message}).\n` +
            `Start it, or point Leglas somewhere else with --user-port.`,
        );
      });

      // The browser gives up on requests all the time: a pane unmounts
      // mid-load, the scan frame moves on, a navigation abandons its module
      // graph. Each one used to run to completion upstream into a response
      // nobody would read, with its socket out of the pool until the dev
      // server finished sending. Let go the moment the browser does.
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });

      req.pipe(upstream);
    },

    upgrade(req, socket, head) {
      options.onActivity?.();
      options.onOpen?.();
      let open = true;
      const closeActivity = () => {
        if (!open) return;
        open = false;
        options.onActivity?.();
        options.onClose?.();
      };
      const upstream = net.connect(port, dialHost, () => {
        const headers = Object.entries(upstreamHeaders(req))
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`)
          .join("");
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      // Tear down in both directions on close as well as error. A tab closing
      // its live-reload socket is an ordinary close, and without this the
      // upstream connection leaks for every tab the user ever opens.
      const shutdown = () => {
        closeActivity();
        upstream.destroy();
        socket.destroy();
      };
      upstream.on("error", shutdown);
      upstream.on("close", shutdown);
      socket.on("error", shutdown);
      socket.on("close", shutdown);
    },
  };
}

/**
 * Put a loopback-only origin in front of one dev server.
 *
 * Branch previews need their own origin because their root-relative assets and
 * live-reload sockets must still point at their own checkout. Owning that
 * origin also gives the branch registry the traffic signal it needs without a
 * shell heartbeat or any changes to the app being previewed.
 */
export function startProxyServer(options: ProxyOptions): Promise<RunningProxy> {
  return new Promise((resolve, reject) => {
    let open = 0;
    const handler = createProxyHandler({
      ...options,
      onOpen: () => {
        open += 1;
        options.onOpen?.();
      },
      onClose: () => {
        open = Math.max(0, open - 1);
        options.onClose?.();
      },
    });
    const server = http.createServer((req, res) => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      handler.request(req, res, `http://127.0.0.1:${port}`);
    });
    const sockets = new Set<Duplex>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (req, socket, head) => handler.upgrade(req, socket, head));

    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      let closed: Promise<void> | null = null;
      resolve({
        active: () => open > 0,
        close: () => {
          if (closed !== null) return closed;
          closed = new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.closeAllConnections();
            server.close(() => done());
          });
          return closed;
        },
        url: `http://127.0.0.1:${port}`,
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}
