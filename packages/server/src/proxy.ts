import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export type ProxyOptions = {
  /** Origin of the dev server being fronted, e.g. http://localhost:3000 */
  target: string;
};

export type ProxyHandler = {
  /** `publicOrigin` is the address the browser used, needed to rewrite redirects. */
  request(req: IncomingMessage, res: ServerResponse, publicOrigin: string): void;
  /** Forwards the websocket handshake. Without this, live reload dies silently. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
};

/**
 * The proxy has one job: be invisible. If an app behaves differently through
 * Leglas than on its own port, the previews are not the real thing and the
 * tool has no reason to exist.
 */
export function createProxyHandler(options: ProxyOptions): ProxyHandler {
  const target = new URL(options.target);
  const host = target.hostname;
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const authority = target.port ? `${host}:${target.port}` : host;

  /**
   * Frameworks build absolute URLs from the Host header. Left as the Leglas
   * origin, they would generate links pointing back at the proxy for routes
   * only the dev server knows about.
   */
  function upstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
    return { ...req.headers, host: authority } as Record<string, string | string[]>;
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
      const upstream = http.request(
        { host, port, method: req.method, path: req.url, headers: upstreamHeaders(req) },
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
      const upstream = net.connect(port, host, () => {
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
