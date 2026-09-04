import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

import type { Preview } from "./config.js";
import { LIVE_PATH, type LiveHub } from "./live.js";
import { SHARE_COOKIE } from "./proxy.js";
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
  | { ok: false; status: 400 | 409 | 500; error: string };

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
  /** Whether a file-preview mount belongs to a direction in the share. */
  fileSlugAllowed(slug: string): Promise<boolean>;
  /**
   * The live hub's viewer count moved. A viewer arriving is the one proof the
   * link answers that no probe from this machine can beat, so it also settles
   * a tunnel still being asked about.
   */
  viewersChanged(): void;
  create(input: unknown): Promise<ShareResult>;
  update(input: unknown): Promise<ShareResult | { ok: false; status: 404; error: string }>;
  viewerConfig(): Promise<unknown | null>;
  stop(): Promise<void>;
  /** Stop, and refuse every share from now on: the server is going. */
  close(): Promise<void>;
};

const ENTRY_PREFIX = "/leglas/s/";

/**
 * Development-server routes that act on the machine or hand out its
 * internals, refused for viewers.
 *
 * A dev server is not only the app. Vite mounts an editor-launch route, and
 * so do the others in their own words: a GET with a file name in the query
 * opens that file in an editor on the machine running the server. Leglas
 * proxies whatever the dev server answers, so before this list a viewer
 * holding a share link could ask for one and the sharer's editor would open.
 * Verified against Vite 8.2.2, where the request reached the middleware and
 * was refused only for want of a file name.
 *
 * The list reaches past JavaScript because `devServer` is only a URL: Leglas
 * will proxy a Django, Rails, Laravel or Spring server as readily as a Vite
 * one, and those ecosystems mount the same class of thing.
 *
 * This is a list of what is known, not a boundary. A framework can add a
 * route tomorrow and a plugin can mount one today, so the share tells the
 * user plainly that a viewer reads what their dev server serves. Adding an
 * entry is a line here.
 *
 * Entries marked "read" come from the package's own source at the version
 * named. Entries marked "reported" come from review and are not confirmed
 * here, so their spelling is the weaker claim.
 *
 * Read and found to need nothing of their own, so the next person need not
 * look again: Astro 7.3.1 (only `/_astro/status`, which answers `{ok:true}`),
 * SvelteKit 2.70.3, Angular 22.1.7 (only its `/@ng/` update routes) and
 * Storybook 10.6.0, whose open-in-editor rides its own websocket channel
 * rather than a route, and viewers cannot upgrade an app's socket. Rsbuild
 * 2.2.3 mounts `/__open-in-editor` with the same launch-editor package Vite
 * uses, so the first entry covers it, and so it does for Vue CLI, Remix and
 * React Router, which sit on Vite or webpack-dev-server.
 *
 * Deliberately absent: Metro and Expo answer at `/open-url` and
 * `/open-stack-frame`, ordinary enough words that an app could own them, and
 * Leglas previews web pages rather than React Native targets. Absent too are
 * the paths an app needs in order to run, `/@fs/`, `/@id/`, `/_next/`,
 * `/_nuxt/`, `/_app/` and `/_astro/` among them.
 */
export const DEV_CONTROL_ROUTES: readonly string[] = [
  /** read, Vite 8.2.2: opens `?file=` in the machine's editor. Rsbuild 2.2.3 too. */
  "/__open-in-editor",
  /** read, react-dev-utils 12.0.1: the same, older name. */
  "/__open-stack-frame-in-editor",
  /** read, react-dev-utils 12.0.1: serves a module's source through the overlay. */
  "/__get-internal-source",
  /** read, vite-plugin-inspect 12.0.2: the module graph and every transformed source. */
  "/__inspect",
  /** read, vite-plugin-vue-devtools 8.2.1: its whole interface and RPC surface. */
  "/__devtools__",
  /** read, browser-sync 3.0.4: its client surface and server metadata. */
  "/__browser_sync__",
  /**
   * read, webpack-dev-server 6.0.0, which mounts its own surface here: the
   * file listing, `/webpack-dev-server/invalidate`, which forces a rebuild,
   * and `/webpack-dev-server/open-editor`, which calls the same launch-editor
   * package Vite does. The subtree match below takes all three.
   */
  "/webpack-dev-server",
  /** reported: Rails Web Console, an interactive server-side REPL. */
  "/__web_console",
  /** reported: the Better Errors gem, likewise. */
  "/__better_errors",
  /** reported: Laravel Ignition, whose solutions endpoint runs code. */
  "/_ignition",
  /** reported: Symfony's profiler, which serves traces, config and source. */
  "/_profiler",
  /** reported: Symfony's web debug toolbar. */
  "/_wdt",
  /** reported: Django Debug Toolbar, which serves settings, SQL and templates. */
  "/__debug__",
  /** reported: Go's pprof, where some GETs start expensive profiling. */
  "/debug/pprof",
  /** reported: Spring Boot Actuator, which can serve env, beans and heap dumps. */
  "/actuator",
  /** reported: Gatsby's development GraphQL surface, schema and content. */
  "/___graphql",
];

/**
 * Namespaces a tool mounts its whole development surface under.
 *
 * Next 16.3.1 answers at least `__nextjs_launch-editor`,
 * `__nextjs_original-stack-frame`, `__nextjs_original-stack-frames`,
 * `__nextjs_source-map`, `__nextjs_error_feedback` and
 * `__nextjs_attach-nodejs-inspector`, which is a debugger for the process
 * serving the app. Listing them one by one would be a list to keep up with
 * and a hole every time a version adds one, and none of them is the app, so
 * the namespace goes rather than its members. What a viewer loses is the
 * error overlay's source mapping, which is the sharer's tool and not theirs.
 */
export const DEV_CONTROL_PREFIXES: readonly string[] = [
  /** read, Next 16.3.1. Its app assets sit at `/_next/` and stay allowed. */
  "/__nextjs_",
  /**
   * read, Nuxt DevTools 4.0.0-alpha.16. Nuxt's own bundle is at `/_nuxt/`,
   * one underscore and a different prefix, so the app is untouched.
   */
  "/__nuxt_devtools__",
  /**
   * read, Parcel 2.16.4: `__parcel_launch_editor` reads a `file` parameter
   * and calls the same launch-editor code Vite does. Beside it sit
   * `__parcel_source_map`, `__parcel_source_root` and `__parcel_code_frame`,
   * which serve source, and the HMR and health routes, which a viewer has no
   * use for: their live-reload socket is already refused.
   */
  "/__parcel_",
];

/**
 * Query keys that turn an ordinary path into a control channel.
 *
 * Everything above reads paths, which is the shape almost every dev tool
 * takes. Werkzeug, under Flask, is the exception worth carrying: its
 * interactive debugger hangs off whichever path raised the error and takes
 * its commands in the query string, so no path rule can see it coming.
 * Reported by review rather than read here.
 */
export const DEV_CONTROL_QUERY_KEYS: readonly string[] = ["__debugger__"];

/**
 * Whether a request asks for one of those, given the url as the server
 * received it. It takes the whole url rather than the path, because one of
 * these hides in the query.
 */
export function isDevControlRequest(url: string): boolean {
  const [path = "/", query] = url.split("?", 2);
  if (DEV_CONTROL_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (DEV_CONTROL_ROUTES.some((route) => path === route || path.startsWith(`${route}/`))) {
    return true;
  }
  if (query === undefined) return false;
  return DEV_CONTROL_QUERY_KEYS.some((key) => new URLSearchParams(query).has(key));
}
/** Where file previews are served, the same prefix the server mounts them under. */
const FILES_PREFIX_PATH = "/leglas/files/";
/** How long a detection of tunnel programs stands before the next ask looks again. */
const DETECT_TTL_MS = 10_000;

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

/** The scheme the viewer used, as the tunnel reports it; http when nobody says. */
function forwardedProto(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",", 1)[0]?.trim() || "http";
}

function publicOrigin(req: http.IncomingMessage): string {
  return `${forwardedProto(req)}://${req.headers.host ?? "127.0.0.1"}`;
}

/**
 * Whether a request came through a tunnel rather than straight to the
 * listener from this machine. cloudflared and ngrok both name the real
 * client; a sharer opening their own local link names nobody.
 */
function throughTunnel(req: http.IncomingMessage): boolean {
  return (
    req.headers["x-forwarded-for"] !== undefined ||
    req.headers["cf-connecting-ip"] !== undefined ||
    req.headers["x-forwarded-proto"] !== undefined
  );
}

function cloneLayout(layout: ShareLayout): ShareLayout {
  return {
    ...layout,
    order: [...layout.order],
    renames: { ...layout.renames },
    collapsedFamilies: [...layout.collapsedFamilies],
  };
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
  let closed = false;
  let stopPromise: Promise<void> | null = null;
  let detectedAt = 0;

  // Looked up again after a little while rather than once for the server's
  // life: the panel tells people to install cloudflared or ngrok, and it
  // has to notice when they do.
  const tunnels = (): Promise<TunnelProviderId[]> => {
    if (detected === null || Date.now() - detectedAt > DETECT_TTL_MS) {
      detectedAt = Date.now();
      detected = detect().catch(() => []);
    }
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
      layout: cloneLayout(share.layout),
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
        (req.method !== "GET" && req.method !== "HEAD") ||
        candidate.includes("/") ||
        !matches(share.token, candidate)
      ) return refuse(req, res);
      const secure = forwardedProto(req) === "https" ? "; Secure" : "";
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
    // A GET that opens an editor is still a write, and the dev server will
    // happily perform one. Refused before the proxy sees it.
    if (isDevControlRequest(req.url ?? "/")) {
      return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
    }
    // A service worker outlives the share: it stays registered on the tunnel
    // origin, serves from its own cache once the link is stopped, and makes
    // fetches of its own. Nothing a viewer needs for a design review, so the
    // registration is refused rather than cleaned up afterwards. The browser
    // sets this destination and script cannot, which is what makes it a
    // usable signal here.
    if (req.headers["sec-fetch-dest"] === "serviceworker") {
      return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
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
    // Only the interface's own socket. An app's live-reload socket is a
    // two-way channel into the dev server, which is a write by another
    // name; a viewer refreshes to see a change instead.
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path !== LIVE_PATH) {
      socket.destroy();
      return;
    }
    // Somebody reaching the socket through the tunnel is the one proof the
    // link answers that no probe from this machine can beat. A socket from
    // this machine (the sharer opening their own local link) proves nothing.
    if (throughTunnel(req)) share.runningTunnel?.settle();
    options.upgrade(req, socket, head);
  };

  const create = async (input: unknown): Promise<ShareResult> => {
    if (closed) return { ok: false, status: 409, error: "Leglas is shutting down." };
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
      if (closed) return { ok: false, status: 409, error: "Leglas is shutting down." };

      const server = http.createServer(request);
      const sockets = new Set<Duplex>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", upgrade);
      let port: number;
      try {
        port = await bind(server);
      } catch (error) {
        // Out of descriptors, or a loopback that will not bind: an answer,
        // never an unhandled rejection taking the proxy down with it.
        return {
          ok: false,
          status: 500,
          error: `Leglas could not open a listener for the share (${
            error instanceof Error ? error.message : String(error)
          }).`,
        };
      }
      if (closed) {
        // The server went while this was binding; nothing must outlive it.
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return { ok: false, status: 409, error: "Leglas is shutting down." };
      }
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
              onState: (next) => {
                if (active !== share || JSON.stringify(share.tunnel) === JSON.stringify(next)) return;
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
    // Viewers read the config, not the share, so both are nudged: the
    // sharer's panel for the status, every viewer for the rail.
    options.live.nudge("share");
    options.live.nudge("config");
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
      // saved layout and names their machine's directories, and the dev
      // server's address names their network. A viewer keeps no layout and
      // never dials the dev server, so the share's own id does the job and
      // the address is left blank.
      project: `share:${share.id}`,
      devServer: "",
      previews: options.previewsForConfig(previews),
      errors: [],
      warnings: [],
      viewer: { scope: share.scope, layout: cloneLayout(share.layout) },
    };
  };

  /**
   * A file preview is served from its whole directory, keyed by a slug made
   * from its title, so a viewer could ask for any mount by guessing the
   * name. Only mounts behind directions in the share answer.
   */
  const fileSlugAllowed = async (slug: string): Promise<boolean> => {
    const share = active;
    if (share === null) return false;
    const titles = new Set(share.titles);
    const previews = await options.previews();
    return previews.some((preview) => {
      if (!titles.has(preview.title) || preview.file === undefined) return false;
      const rest = preview.url.startsWith(FILES_PREFIX_PATH) ? preview.url.slice(FILES_PREFIX_PATH.length) : "";
      const slash = rest.indexOf("/");
      return (slash === -1 ? rest : rest.slice(0, slash)) === slug;
    });
  };

  const viewersChanged = (): void => {
    if (active !== null) options.live.nudge("share");
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

  const close = async (): Promise<void> => {
    closed = true;
    await stop();
  };

  return { tunnels, status, fileSlugAllowed, viewersChanged, create, update, viewerConfig, stop, close };
}
