import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

import type { Preview } from "./config.js";
import type { LiveHub } from "./live.js";
import {
  detectTunnels,
  startTunnel,
  type RunningTunnel,
  type TunnelProviderId,
  type TunnelState,
} from "./tunnel.js";

export type ShareScope = "direction" | "compare" | "rail";

export type ShareLayout = {
  /** Rail order, whole rail; viewers only see `titles`, in this order. */
  order: string[];
  renames: Record<string, string>;
  hidden: string[];
  collapsedFamilies: string[];
  /** The right pane when the scope is compare; null otherwise. */
  compare: string | null;
  /** null is Full. */
  viewport: number | null;
};

export type ShareStatus = {
  id: string;
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  /** Entry link on the share listener, for a tunnel the user runs themselves. */
  localUrl: string;
  sharePort: number;
  /** Public entry link once a tunnel has a URL, else null. */
  url: string | null;
  tunnel: TunnelState;
  viewers: number;
  startedAt: number;
};

type ShareManifest = {
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
};

type ShareResult =
  | { ok: true; share: ShareStatus }
  | { ok: false; status: 400 | 409; error: string };

type RequestContext = {
  publicOrigin: string;
};

type ShareManagerOptions = {
  live: LiveHub;
  previews: () => Promise<Preview[]>;
  previewsForConfig: (previews: readonly Preview[]) => readonly unknown[];
  viewerConfig: {
    project: string;
    devServer: string;
    scanPreviews: boolean;
  };
  request: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: RequestContext,
  ) => void;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  detectTunnels?: typeof detectTunnels;
  startTunnel?: typeof startTunnel;
  now?: () => number;
};

type ActiveShare = ShareManifest & {
  id: string;
  token: string;
  port: number;
  startedAt: number;
  tunnel: TunnelState;
  runningTunnel: RunningTunnel | null;
  server: http.Server;
  sockets: Set<Duplex>;
  launch: ReturnType<typeof setImmediate> | null;
};

type ShareManager = {
  tunnels(): Promise<TunnelProviderId[]>;
  status(): ShareStatus | null;
  /**
   * The live hub's viewer count moved. A viewer arriving is the one proof the
   * link answers that no probe from this machine can beat, so it also settles
   * a tunnel still being asked about.
   */
  viewersChanged(count: number): void;
  create(input: unknown): Promise<ShareResult>;
  update(input: unknown): Promise<ShareResult | { ok: false; status: 404; error: string }>;
  viewerConfig(): Promise<unknown | null>;
  stop(): Promise<void>;
};

const ENTRY_PREFIX = "/leglas/s/";
const SHARE_COOKIE = "leglas-share";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function layoutFrom(value: unknown): ShareLayout | null {
  if (!isRecord(value)) return null;
  if (
    !stringArray(value.order) ||
    !stringRecord(value.renames) ||
    !stringArray(value.hidden) ||
    !stringArray(value.collapsedFamilies) ||
    (value.compare !== null && typeof value.compare !== "string") ||
    (value.viewport !== null &&
      (typeof value.viewport !== "number" || !Number.isFinite(value.viewport)))
  ) {
    return null;
  }
  return {
    order: [...value.order],
    renames: { ...value.renames },
    hidden: [...value.hidden],
    collapsedFamilies: [...value.collapsedFamilies],
    compare: value.compare,
    viewport: value.viewport,
  };
}

function manifestFrom(
  value: unknown,
  previews: readonly Preview[],
): { ok: true; manifest: ShareManifest } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "Share details must be a JSON object." };
  }
  const scope = value.scope;
  const layout = layoutFrom(value.layout);
  if (
    (scope !== "direction" && scope !== "compare" && scope !== "rail") ||
    !stringArray(value.titles) ||
    layout === null
  ) {
    return { ok: false, error: "Share details need a scope, directions and a complete layout." };
  }
  const titles = [...value.titles];
  if (titles.length === 0) {
    return { ok: false, error: "Choose at least one direction to share." };
  }

  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));
  const unknown = [...new Set(titles.filter((title) => !byTitle.has(title)))];
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Directions are not available to share: ${unknown.join(", ")}.`,
    };
  }
  const branches = [
    ...new Set(
      titles.filter((title) => byTitle.get(title)?.branch !== undefined),
    ),
  ];
  if (branches.length > 0) {
    return {
      ok: false,
      error: `Branch directions can't be shared yet: ${branches.join(", ")}.`,
    };
  }
  if (scope === "direction" && titles.length > 1) {
    return { ok: false, error: "A direction share can contain only one direction." };
  }
  if (
    scope === "compare" &&
    (titles.length !== 2 ||
      new Set(titles).size !== 2 ||
      layout.compare === null ||
      !titles.includes(layout.compare))
  ) {
    return {
      ok: false,
      error: "A comparison share needs exactly two directions and one of them on the right.",
    };
  }
  if (scope !== "compare" && layout.compare !== null) {
    return { ok: false, error: "Only a comparison share can name a right pane." };
  }
  return { ok: true, manifest: { scope, titles, layout } };
}

function matches(secret: string, candidate: string): boolean {
  const expected = Buffer.from(secret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function cookieToken(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie;
  const cookies = (Array.isArray(raw) ? raw.join(";") : raw ?? "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() !== SHARE_COOKIE) continue;
    return cookie.slice(separator + 1).trim();
  }
  return null;
}

function publicOrigin(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const protocol = first?.split(",", 1)[0]?.trim() || "http";
  return `${protocol}://${req.headers.host ?? "127.0.0.1"}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function refuse(req: http.IncomingMessage, res: http.ServerResponse): void {
  const accept = req.headers.accept;
  const html = (Array.isArray(accept) ? accept.join(",") : accept ?? "").includes("text/html");
  if (!html) {
    return sendJson(res, 403, { ok: false, error: "This link isn't active." });
  }
  res.writeHead(403, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This Leglas link isn't active</title>
<body style="margin:0;background:#1C1C20;color:#f5f4f1;font:16px/1.5 ui-sans-serif,system-ui;display:grid;min-height:100vh;place-items:center">
<main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem">This Leglas link isn't active</h1>
<p>The person sharing it may have stopped, or this is not the link they sent.</p></main>
</body>`);
}

function bind(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeListener(share: ActiveShare): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of share.sockets) socket.destroy();
    share.sockets.clear();
    share.server.closeAllConnections();
    share.server.close(() => resolve());
  });
}

/**
 * Own the one active share. The second listener supplies the security fact:
 * once a request arrives here it is a viewer, even though its peer is local.
 */
export function createShareManager(options: ShareManagerOptions): ShareManager {
  const detect = options.detectTunnels ?? detectTunnels;
  const runTunnel = options.startTunnel ?? startTunnel;
  const now = options.now ?? Date.now;
  let detected: Promise<TunnelProviderId[]> | null = null;
  let active: ActiveShare | null = null;
  let creating = false;
  let stopPromise: Promise<void> | null = null;

  const tunnels = (): Promise<TunnelProviderId[]> => {
    detected ??= detect().catch(() => []);
    return detected;
  };

  const status = (): ShareStatus | null => {
    const share = active;
    if (share === null) return null;
    const entryPath = `${ENTRY_PREFIX}${share.token}`;
    const tunnelUrl = "url" in share.tunnel ? share.tunnel.url : undefined;
    return {
      id: share.id,
      scope: share.scope,
      titles: [...share.titles],
      layout: {
        ...share.layout,
        order: [...share.layout.order],
        renames: { ...share.layout.renames },
        hidden: [...share.layout.hidden],
        collapsedFamilies: [...share.layout.collapsedFamilies],
      },
      localUrl: `http://127.0.0.1:${share.port}${entryPath}`,
      sharePort: share.port,
      url:
        tunnelUrl === undefined
          ? null
          : `${tunnelUrl.replace(/\/$/, "")}${entryPath}`,
      tunnel: { ...share.tunnel },
      viewers: options.live.viewers,
      startedAt: share.startedAt,
    };
  };

  const request = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const share = active;
    if (share === null) return refuse(req, res);
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path.startsWith(ENTRY_PREFIX)) {
      const candidate = path.slice(ENTRY_PREFIX.length);
      if (
        req.method !== "GET" ||
        candidate.includes("/") ||
        !matches(share.token, candidate)
      ) return refuse(req, res);
      const forwarded = req.headers["x-forwarded-proto"];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const secure = first?.split(",", 1)[0]?.trim() === "https" ? "; Secure" : "";
      res.writeHead(302, {
        location: "/leglas/",
        "set-cookie": `${SHARE_COOKIE}=${share.token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const cookie = cookieToken(req);
    if (cookie === null || !matches(share.token, cookie)) return refuse(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 403, {
        ok: false,
        error: "Viewers can look, not change what runs.",
      });
    }
    options.request(req, res, { publicOrigin: publicOrigin(req) });
  };

  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const share = active;
    const cookie = cookieToken(req);
    if (share === null || cookie === null || !matches(share.token, cookie)) {
      socket.destroy();
      return;
    }
    options.upgrade(req, socket, head);
  };

  const create = async (input: unknown): Promise<ShareResult> => {
    if (active !== null || creating) {
      return { ok: false, status: 409, error: "Stop the current share first." };
    }
    creating = true;
    try {
      const previews = await options.previews();
      const parsed = manifestFrom(input, previews);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      const providers = await tunnels();
      const requested = isRecord(input) ? input.tunnel : undefined;
      if (
        requested !== undefined &&
        requested !== "none" &&
        requested !== "cloudflared" &&
        requested !== "ngrok"
      ) {
        return { ok: false, status: 400, error: "That tunnel provider is not supported." };
      }
      if (requested !== undefined && requested !== "none" && !providers.includes(requested)) {
        return {
          ok: false,
          status: 400,
          error: `${requested} is not available on this machine.`,
        };
      }
      const provider = requested ?? providers[0] ?? "none";
      if (active !== null) {
        return { ok: false, status: 409, error: "Stop the current share first." };
      }

      const server = http.createServer(request);
      const sockets = new Set<Duplex>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", upgrade);
      const port = await bind(server);
      const share: ActiveShare = {
        ...parsed.manifest,
        id: randomUUID(),
        token: randomBytes(24).toString("base64url"),
        port,
        startedAt: now(),
        tunnel:
          provider === "none"
            ? { status: "none" }
            : { status: "starting", provider },
        runningTunnel: null,
        server,
        sockets,
        launch: null,
      };
      active = share;
      options.live.nudge("share");

      if (provider !== "none") {
        share.launch = setImmediate(() => {
          share.launch = null;
          if (active !== share) return;
          share.runningTunnel = runTunnel(
            {
              provider,
              port,
              entryPath: `${ENTRY_PREFIX}${share.token}`,
              onState: (reported) => {
                if (active !== share) return;
                // A viewer may have settled the link before the probe did;
                // the process going after that is the process going, not
                // a tunnel that never came up.
                const next: TunnelState =
                  share.tunnel.status === "ready" && reported.status === "failed"
                    ? { ...reported, reason: "The tunnel process exited." }
                    : share.tunnel.status === "ready" && reported.status === "starting"
                      ? share.tunnel
                      : reported;
                if (JSON.stringify(share.tunnel) === JSON.stringify(next)) return;
                share.tunnel = next;
                options.live.nudge("share");
              },
            },
          );
        });
        share.launch.unref?.();
      }
      return { ok: true, share: status() as ShareStatus };
    } finally {
      creating = false;
    }
  };

  const update = async (
    input: unknown,
  ): Promise<ShareResult | { ok: false; status: 404; error: string }> => {
    const share = active;
    if (share === null) {
      return { ok: false, status: 404, error: "Nothing is being shared." };
    }
    const parsed = manifestFrom(input, await options.previews());
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    if (active !== share) {
      return { ok: false, status: 404, error: "Nothing is being shared." };
    }
    share.scope = parsed.manifest.scope;
    share.titles = parsed.manifest.titles;
    share.layout = parsed.manifest.layout;
    options.live.nudge("share");
    return { ok: true, share: status() as ShareStatus };
  };

  const viewerConfig = async (): Promise<unknown | null> => {
    const share = active;
    if (share === null) return null;
    const titles = new Set(share.titles);
    const previews = (await options.previews()).filter((preview) => titles.has(preview.title));
    if (active !== share) return null;
    return {
      ...options.viewerConfig,
      // The project id is the config's absolute path, which keys the sharer's
      // saved layout and names their machine's directories. A viewer keeps
      // no layout, so the share's own id does the job and says nothing.
      project: `share:${share.id}`,
      previews: options.previewsForConfig(previews),
      errors: [],
      warnings: [],
      viewer: {
        scope: share.scope,
        layout: {
          ...share.layout,
          order: [...share.layout.order],
          renames: { ...share.layout.renames },
          hidden: [...share.layout.hidden],
          collapsedFamilies: [...share.layout.collapsedFamilies],
        },
      },
    };
  };

  const viewersChanged = (count: number): void => {
    const share = active;
    if (share === null) return;
    if (count > 0 && share.tunnel.status === "starting" && share.tunnel.url !== undefined) {
      share.tunnel = { status: "ready", provider: share.tunnel.provider, url: share.tunnel.url };
    }
    options.live.nudge("share");
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    const share = active;
    if (share === null) return Promise.resolve();
    if (share.launch !== null) {
      clearImmediate(share.launch);
      share.launch = null;
    }
    stopPromise = (async () => {
      await share.runningTunnel?.stop().catch(() => {});
      await closeListener(share);
      if (active === share) active = null;
      options.live.nudge("share");
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  return { tunnels, status, viewersChanged, create, update, viewerConfig, stop };
}
