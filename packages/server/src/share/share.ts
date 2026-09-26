import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { posix } from "node:path";
import type { Duplex } from "node:stream";

import type { Preview } from "../config/config.js";
import { LIVE_PATH, type LiveHub } from "../live.js";
import { SHARE_COOKIE } from "../proxy.js";
import {
  detectTunnels,
  startTunnel,
  type RunningTunnel,
  type TunnelProviderId,
  type TunnelState,
} from "./tunnel.js";

import { isNumber, isString, isJsonRecord, type JsonValue } from "../json.js";

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
  reach: ShareReach;
  routes: string[];
  /** What `listed` turned away, so the sharer can see it and decide. */
  refused: string[];
  sharePort: number;
  grants: Array<{
    id: string;
    name: string;
    url: string | null;
    localUrl: string;
    viewers: number;
    createdAt: number;
    expiresAt: number;
  }>;
  tunnel: TunnelState;
  startedAt: number;
};

export type Grant = {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  /** Monotonic deadline for the same instant; the earlier one wins. */
  expiresAtMono: bigint;
  /** Set when it is over, which is why the viewer can be told which. */
  endedAt: number | null;
  endedBy: "expiry" | "revoke" | null;
  /** Live sockets attached under this grant. */
  viewers: number;
};

/**
 * How far a viewer may reach into the dev server. `open` is everything over GET
 * minus the control routes; `listed` is only the share's own list. The list is
 * decided by path on the server, so a console, a service worker and curl all
 * hit it the same way.
 */
export type ShareReach = "open" | "listed";

type ShareManifest = {
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  reach: ShareReach;
  /**
   * Paths a viewer may load in `listed` mode: an entry ending in `/` covers
   * everything beneath it, anything else one exact path. Seeded from what the
   * sharer's browser loaded for these directions, since nobody can list a
   * bundler's asset graph by hand.
   */
  routes: string[];
};

/** How many refusals a share remembers, so the panel can offer to allow them. */
const MAX_REFUSED = 40;

/** Whether the list lets this path through, checked on the settled path. */
export function routeAllowed(routes: readonly string[], url: string): boolean {
  const [rawPath = "/"] = url.split("?", 2);
  // The settled path, never a list of readings: asking whether any spelling is
  // allowed lets the most permissive win, and "/assets/../secrets" starts with
  // "/assets/" as a string.
  const path = canonical(rawPath);

  return routes.some((route) => {
    // The root isn't a directory, or an app served at "/" would allow every
    // path.
    const prefix = route.endsWith("/") && route !== "/";

    // An exact route also matches itself with a trailing slash; dev servers
    // treat both as one resource, and a browser asks for a directory index with
    // the slash.
    return prefix
      ? path.startsWith(route) || `${path}/` === route
      : path === route || path === `${route}/`;
  });
}

export type ShareResult =
  { ok: true; share: ShareStatus } | { ok: false; status: 400 | 404 | 409 | 500; error: string };

type RequestContext = {
  publicOrigin: string;
  grantId: string;
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
  request: (req: http.IncomingMessage, res: http.ServerResponse, context: RequestContext) => void;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  detectTunnels?: typeof detectTunnels;
  startTunnel?: typeof startTunnel;
  now?: () => number;
  nowMono?: () => bigint;
  /** The budget in {@link VIEWER_DEADLINE_MS}, shortened so tests can reach it. */
  viewerDeadlineMs?: number;
};

type ActiveShare = ShareManifest & {
  id: string;
  grants: Map<string, Grant>;
  tombstones: Grant[];
  port: number;
  startedAt: number;
  tunnel: TunnelState;
  runningTunnel: RunningTunnel | null;
  tunnelGeneration: number;
  server: http.Server;
  sockets: Set<Duplex>;
  grantSockets: Map<string, Set<Duplex>>;
  grantRequests: Map<string, Set<{ req: http.IncomingMessage; res: http.ServerResponse }>>;
  launch: ReturnType<typeof setImmediate> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** Paths `listed` mode turned away, newest last, so they can be allowed. */
  refused: string[];
  /** Viewer requests currently inside the dev server. */
  running: number;
  /** Per link, in arrival order, waiting for a slot. */
  waiting: Map<string, Waiting[]>;
  /** Links with somebody waiting, in the order their turn comes. */
  rota: string[];
};

/** One viewer request holding a place in the queue. */
type Waiting = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  grantId: string;
  /** When this request's budget runs out, as a wall-clock instant. */
  spentAt: number;
  /** Runs the request. Called once, by whoever gives it the slot. */
  start: () => void;
  /** Turn it away for having waited too long. */
  shed: () => void;
  /** Takes it out of the queue. Idempotent, and clears the deadline. */
  drop: () => boolean;
};

type ViewerConfig = ShareManagerOptions["viewerConfig"] & {
  project: string;
  devServer: string;
  previews: ReturnType<ShareManagerOptions["previewsForConfig"]>;
  errors: string[];
  warnings: string[];
  viewer: { scope: ShareScope; layout: ShareLayout };
};

type ShareManager = {
  tunnels(): Promise<TunnelProviderId[]>;
  status(): ShareStatus | null;
  /** Whether a file-preview mount belongs to a direction in the share. */
  fileSlugAllowed(slug: string, grantId: string): Promise<boolean>;
  allowRoute(input: JsonValue | undefined): ShareResult;
  create(input: JsonValue | undefined): Promise<ShareResult>;
  createGrant(input: JsonValue | undefined): ShareResult;
  revokeGrant(input: JsonValue | undefined): ShareResult;
  extendGrant(input: JsonValue | undefined): ShareResult;
  rotate(): Promise<ShareResult>;
  update(input: JsonValue | undefined): Promise<ShareResult>;
  viewerConfig(grantId: string): Promise<ViewerConfig | null>;
  stop(): Promise<void>;
  /** Stop, and refuse every share from now on: the server is going. */
  close(): Promise<void>;
};

/** Everything Leglas serves itself. Not imported from the server, which imports this file. */
const OWN_PREFIX = "/leglas";

const ENTRY_PREFIX = `${OWN_PREFIX}/s/`;

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_GRANTS = 16;

export const MAX_TOMBSTONES = 32;

/**
 * How many viewer requests may be inside the dev server at once. A loaded dev
 * server doesn't fail, it queues internally where nothing here can bound or
 * cancel it, and the sharer's reload waits behind it. On Vite with 200 viewer
 * requests at once: unbounded, the sharer's reload took 136ms at 974 req/s; at
 * twelve, 21ms at 1415 req/s.
 *
 * Twelve because a real page load peaked at six concurrent requests (the
 * browser's per-origin cap), so two page loads never wait.
 */
export const VIEWER_CONCURRENCY = 12;

/**
 * How many of one link's requests may wait. Above a full HTTP/2 burst, since a
 * tunnel lifts the six-connection cap. Per link, so one link can't fill the
 * queue and shed another.
 */
export const VIEWER_QUEUE = 128;

/**
 * How long a viewer request has to start a response from arrival, covering the
 * slot wait and the dev server as one budget.
 */
export const VIEWER_DEADLINE_MS = 30_000;

/**
 * Dev-server routes that act on the machine or expose its internals, refused
 * for viewers. Vite and others mount an editor-launch route that opens `?file=`
 * on the sharer's machine, and Leglas proxies whatever the dev server answers
 * (confirmed on Vite 8.2.2). `devServer` is just a URL, so Django, Rails,
 * Laravel and Spring routes are here too.
 *
 * A list of what's known, not a boundary: the share tells the user plainly that
 * a viewer reads what their dev server serves. "read" entries come from the
 * package source at the named version; "reported" ones came from review and
 * aren't confirmed here.
 *
 * Checked and needing nothing: Astro 7.3.1 (only `/_astro/status`), SvelteKit
 * 2.70.3, Angular 22.1.7 (only `/@ng/` update routes), Storybook 10.6.0
 * (open-in-editor goes over its own websocket, which viewers can't upgrade).
 * Rsbuild 2.2.3, Vue CLI, Remix and React Router are covered by the first
 * entry.
 *
 * Left out on purpose: Metro and Expo's `/open-url` and `/open-stack-frame`
 * (words an app could own; Leglas previews web pages), and the paths an app
 * needs to run, like `/@fs/`, `/@id/`, `/_next/`, `/_nuxt/`, `/_app/` and
 * `/_astro/`.
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
   * read, webpack-dev-server 6.0.0: the file listing,
   * `/webpack-dev-server/invalidate` (forces a rebuild) and
   * `/webpack-dev-server/open-editor` (launch-editor again). The subtree match
   * covers all three.
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
 * Namespaces a tool mounts its whole dev surface under. Next 16.3.1 answers
 * `__nextjs_launch-editor`, `__nextjs_original-stack-frame(s)`,
 * `__nextjs_source-map`, `__nextjs_error_feedback` and
 * `__nextjs_attach-nodejs-inspector` (a debugger for the serving process), and
 * versions add more, so the namespace goes. Viewers lose only the overlay's
 * source mapping.
 */
export const DEV_CONTROL_PREFIXES: readonly string[] = [
  /** read, Next 16.3.1. Its app assets sit at `/_next/` and stay allowed. */
  "/__nextjs_",
  /** read, Nuxt DevTools 4.0.0-alpha.16. Nuxt's bundle is at `/_nuxt/`, a different prefix. */
  "/__nuxt_devtools__",
  /**
   * read, Parcel 2.16.4: `__parcel_launch_editor` takes a `file` and calls
   * launch-editor. Its source-map, source-root, code-frame, HMR and health
   * routes serve source or are useless to a viewer.
   */
  "/__parcel_",
];

/**
 * Query keys that turn an ordinary path into a control channel. Werkzeug's
 * debugger (Flask) hangs off whichever path raised the error and takes commands
 * in the query, so no path rule sees it. Reported, not read here.
 */
export const DEV_CONTROL_QUERY_KEYS: readonly string[] = ["__debugger__"];

/**
 * Every spelling of a path to consider, since the dev server does its own
 * matching. Vite 8.2.2 answers `/__OPEN-IN-EDITOR` like the lowercase one, so
 * case is the confirmed gap; `//a`, `/./a` and `/x/../a` are the same class,
 * closed because refusing a path the app never had costs nothing.
 *
 * Decoded once: decoding in a loop would refuse paths that legitimately contain
 * an encoded percent. A backslash is a slash, since both of Node's URL parsers
 * read `/foo\..\x` as `/x`.
 */
/**
 * The one reading that says what will be served. {@link spellings} is for
 * refusing, where any dangerous reading should win; for allowing, the most
 * permissive reading would win, so allow decisions use this settled path only.
 */
function canonical(path: string): string {
  let form = path;

  try {
    form = decodeURIComponent(path);
  } catch {
    // A malformed escape is not a spelling of anything; the raw form stands.
  }

  return posix.normalize(form.replaceAll("\\", "/").replace(/\/{2,}/g, "/"));
}

function spellings(path: string): string[] {
  const seen = new Set<string>();

  const add = (value: string): void => {
    seen.add(value);
    seen.add(value.toLowerCase());
  };

  add(path);
  const forms = [path];

  try {
    forms.push(decodeURIComponent(path));
  } catch {
    // A malformed escape is not a spelling of anything; the raw form stands.
  }

  for (const value of forms) {
    add(value);

    for (const slashed of [value, value.replaceAll("\\", "/")]) {
      const collapsed = slashed.replace(/\/{2,}/g, "/");
      add(collapsed);
      add(posix.normalize(collapsed));
    }
  }

  return [...seen];
}

/** Takes the whole url, not the path, because one of these hides in the query. */
export function isDevControlRequest(url: string): boolean {
  const [rawPath = "/", query] = url.split("?", 2);

  for (const path of spellings(rawPath)) {
    if (DEV_CONTROL_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;

    if (DEV_CONTROL_ROUTES.some((route) => path === route || path.startsWith(`${route}/`))) {
      return true;
    }
  }

  if (query === undefined) return false;
  const keys = new URLSearchParams(query);

  return DEV_CONTROL_QUERY_KEYS.some((key) => keys.has(key) || keys.has(key.toUpperCase()));
}

/** Where file previews are served, the same prefix the server mounts them under. */
/**
 * Whether a path reaches for something hidden. A leading dot usually means
 * credentials (`.env`, `.git`, `.ssh`, `.aws`), so it's refused whatever the
 * reach and never offered for Allow.
 *
 * Stops at `node_modules`: dev servers serve dependencies from dot directories
 * (eight of the demo app's twenty-two files are under `node_modules/.vite/deps`
 * or `.pnpm`). Climbing back out of `node_modules` is caught by the normalised
 * spelling.
 */
export function isHiddenPath(path: string): boolean {
  return spellings(path).some((form) => {
    const segments = form.split("/");
    const modules = segments.indexOf("node_modules");

    return segments.some((segment, at) => {
      if (!segment.startsWith(".") || segment === "." || segment === "..") return false;
      // Only dot directories are exempt, never a dotfile under one: a package's
      // own `.env` is still a `.env`.
      const last = at === segments.length - 1;

      return last || !(modules >= 0 && at > modules);
    });
  });
}

const FILES_PREFIX_PATH = "/leglas/files/";

/** How long a detection of tunnel programs stands before the next ask looks again. */
const DETECT_TTL_MS = 10_000;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isJsonRecord(value) && Object.values(value).every((entry) => isString(entry));
}

function layoutFrom(value: JsonValue | undefined): ShareLayout | null {
  if (!isJsonRecord(value)) return null;

  if (
    !stringArray(value.order) ||
    !stringRecord(value.renames) ||
    !stringArray(value.collapsedFamilies) ||
    (value.compare !== null && !isString(value.compare)) ||
    (value.viewport !== null && (!isNumber(value.viewport) || !Number.isFinite(value.viewport)))
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
  value: JsonValue | undefined,
  previews: readonly Preview[],
): { ok: true; manifest: ShareManifest } | { ok: false; error: string } {
  if (!isJsonRecord(value)) {
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

  const branches = [...new Set(titles.filter((title) => byTitle.get(title)?.branch !== undefined))];

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

  const reach = value.reach === "listed" ? "listed" : "open";

  if (value.reach !== undefined && value.reach !== "open" && value.reach !== "listed") {
    return { ok: false, error: "Reach is either open or listed." };
  }

  if (value.routes !== undefined && !stringArray(value.routes)) {
    return { ok: false, error: "The route list must be an array of paths." };
  }

  // Only paths that could be asked for: a route without a leading slash never
  // matches, so it's reported as a mistake.
  const routes = [...new Set((value.routes ?? []).map((route) => route.split("?", 1)[0] ?? ""))]
    .filter((route) => route !== "")
    .slice(0, 400);

  if (routes.some((route) => !route.startsWith("/"))) {
    return { ok: false, error: "Every route must be a path beginning with a slash." };
  }

  // The shared directions are always in; a share that refuses its own pages
  // isn't one.
  const own = titles.flatMap((title) => {
    const url = byTitle.get(title)?.url;

    return url === undefined ? [] : [url.split("?", 1)[0] ?? ""];
  });

  return {
    ok: true,
    manifest: { scope, titles, layout, reach, routes: [...new Set([...routes, ...own])] },
  };
}

/**
 * Finds the grant a token names, in constant time across live grants. Compared
 * as written, not decoded: base64url decoding drops unknown characters, so a
 * token with a stray trailing character would match. Every grant is compared
 * with no early exit, so timing reveals nothing about which or how many links
 * exist.
 */
function matchOne(candidate: string, grants: Iterable<Grant>): Grant | null {
  const received = Buffer.from(candidate, "utf8");
  let found: Grant | null = null;

  for (const grant of grants) {
    const expected = Buffer.from(grant.token, "utf8");

    if (expected.length !== received.length) continue;

    if (timingSafeEqual(expected, received)) found = grant;
  }

  return found;
}

function grantFor(share: ActiveShare, candidate: string): Grant | null {
  return matchOne(candidate, share.grants.values());
}

/** The same, over the links that have ended, so a viewer can be told which. */
function endedGrantFor(share: ActiveShare, candidate: string): Grant | null {
  return matchOne(candidate, share.tombstones);
}

/**
 * Whether a link is over, by two clocks with the earlier winning. After sleep
 * the wall clock is right and the monotonic one under-counts, so the wall clock
 * expires links across a closed laptop; a wall clock dragged backwards loses to
 * the monotonic one. Neither alone can extend a link.
 */
function expired(grant: Grant, now: number, nowMono: bigint): boolean {
  return now >= grant.expiresAt || nowMono >= grant.expiresAtMono;
}

function cookieToken(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie;
  const cookies = (Array.isArray(raw) ? raw.join(";") : (raw ?? "")).split(";");

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
 * Whether a request came through a tunnel: cloudflared and ngrok name the real
 * client, and a sharer opening their own local link names nobody.
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

function sendJson<T>(res: http.ServerResponse, status: number, body: T): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

type Refusal = "inactive" | "expiry" | "revoke";

const REFUSALS: Record<Refusal, { status: 403 | 410; sentence: string; title: string }> = {
  inactive: {
    status: 403,
    sentence: "This link isn't active.",
    title: "This Leglas link isn't active",
  },
  expiry: {
    status: 410,
    sentence: "This link expired. The person sharing it can send a new one.",
    title: "This Leglas link expired",
  },
  revoke: {
    status: 410,
    sentence: "This link was turned off.",
    title: "This Leglas link was turned off",
  },
};

function refuse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cause: Refusal = "inactive",
): void {
  const refusal = REFUSALS[cause];
  const accept = req.headers.accept;
  const html = (Array.isArray(accept) ? accept.join(",") : (accept ?? "")).includes("text/html");

  if (!html) {
    return sendJson(res, refusal.status, { ok: false, error: refusal.sentence });
  }

  res.writeHead(refusal.status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${refusal.title}</title>
<body style="margin:0;background:#1C1C20;color:#f5f4f1;font:16px/1.5 ui-sans-serif,system-ui;display:grid;min-height:100vh;place-items:center">
<main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem">${refusal.title}</h1>
<p>${refusal.sentence}</p></main>
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
      resolve(address !== null && !isString(address) ? address.port : 0);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeListener(share: ActiveShare): Promise<void> {
  return new Promise((resolve) => {
    if (share.expiryTimer !== null) {
      clearTimeout(share.expiryTimer);
      share.expiryTimer = null;
    }

    for (const socket of share.sockets) socket.destroy();
    share.sockets.clear();
    share.server.closeAllConnections();
    share.server.close(() => resolve());
  });
}

/**
 * Owns the one active share. Arriving on the second listener is what makes a
 * request a viewer, even with a local peer.
 */
export function createShareManager(options: ShareManagerOptions): ShareManager {
  const detect = options.detectTunnels ?? detectTunnels;
  const runTunnel = options.startTunnel ?? startTunnel;
  const now = options.now ?? Date.now;
  /**
   * `hrtime` doesn't advance while the machine sleeps, which is why it's paired
   * with the wall clock.
   */
  const nowMono = options.nowMono ?? process.hrtime.bigint;
  const deadlineMs = options.viewerDeadlineMs ?? VIEWER_DEADLINE_MS;
  let detected: Promise<TunnelProviderId[]> | null = null;
  let active: ActiveShare | null = null;
  let creating = false;
  /**
   * Bumped by every stop. A create reads it before starting and again once it
   * holds a listener, since a stop in between (while reading previews, finding
   * tunnels, binding a port) used to report success and leave the share to come
   * up behind it. Same shape as `closed` below.
   */
  let stops = 0;
  let closed = false;
  let stopPromise: Promise<void> | null = null;
  let detectedAt = 0;

  // Looked up again after a while, since the panel tells people to install
  // cloudflared or ngrok and should notice when they do.
  const tunnels = (): Promise<TunnelProviderId[]> => {
    if (detected === null || Date.now() - detectedAt > DETECT_TTL_MS) {
      detectedAt = Date.now();
      detected = detect().catch(() => []);
    }

    return detected;
  };

  const snapshot = (share: ActiveShare): ShareStatus => {
    const tunnelUrl = "url" in share.tunnel ? share.tunnel.url : undefined;
    const origin = tunnelUrl === undefined ? null : tunnelUrl.replace(/\/$/, "");

    return {
      id: share.id,
      scope: share.scope,
      titles: [...share.titles],
      layout: cloneLayout(share.layout),
      sharePort: share.port,
      grants: Array.from(share.grants.values())
        .toSorted((a, b) => a.createdAt - b.createdAt)
        .map((grant) => {
          const entryPath = `${ENTRY_PREFIX}${grant.token}`;

          return {
            id: grant.id,
            name: grant.name,
            url: origin === null ? null : `${origin}${entryPath}`,
            localUrl: `http://127.0.0.1:${share.port}${entryPath}`,
            viewers: grant.viewers,
            createdAt: grant.createdAt,
            expiresAt: grant.expiresAt,
          };
        }),
      reach: share.reach,
      routes: [...share.routes],
      refused: [...share.refused],
      tunnel: { ...share.tunnel },
      startedAt: share.startedAt,
    };
  };

  const status = (): ShareStatus | null => (active === null ? null : snapshot(active));

  /**
   * Ends one link and releases what it holds: its sockets and the proxied
   * requests running under it, since an SSE stream would otherwise keep
   * delivering after the cut. The tombstone lets the next request on that token
   * be told which ending it was.
   */
  const endGrant = (share: ActiveShare, grant: Grant, why: "expiry" | "revoke"): void => {
    if (!share.grants.delete(grant.id)) return;
    grant.endedAt = now();
    grant.endedBy = why;
    grant.viewers = 0;
    share.tombstones.push(grant);

    while (share.tombstones.length > MAX_TOMBSTONES) share.tombstones.shift();

    for (const socket of share.grantSockets.get(grant.id) ?? []) socket.destroy();
    share.grantSockets.delete(grant.id);

    for (const held of share.grantRequests.get(grant.id) ?? []) {
      held.res.destroy();
      held.req.destroy();
    }

    share.grantRequests.delete(grant.id);

    // Requests waiting under this link get the same answer a live one would,
    // not a dropped connection.
    for (const held of Array.from(share.waiting.get(grant.id) ?? [])) {
      if (held.drop()) refuse(held.req, held.res, why);
    }

    share.waiting.delete(grant.id);
    const turn = share.rota.indexOf(grant.id);

    if (turn >= 0) share.rota.splice(turn, 1);
  };

  /**
   * Drops whatever has run out and schedules the next check. The timer only
   * makes the end prompt; expiry is checked against the clock wherever work
   * begins, since a suspended process can wake long past a timer that never
   * fired.
   */
  const sweepExpiry = (): void => {
    const share = active;

    if (share === null) return;

    if (share.expiryTimer !== null) {
      clearTimeout(share.expiryTimer);
      share.expiryTimer = null;
    }

    const at = now();
    const mono = nowMono();
    let ended = false;

    for (const grant of Array.from(share.grants.values())) {
      if (!expired(grant, at, mono)) continue;
      endGrant(share, grant, "expiry");
      ended = true;
    }

    const next = Array.from(share.grants.values()).reduce<number | null>(
      (soonest, grant) => (soonest === null ? grant.expiresAt : Math.min(soonest, grant.expiresAt)),
      null,
    );

    if (next !== null) {
      share.expiryTimer = setTimeout(sweepExpiry, Math.max(1, next - at));
      share.expiryTimer.unref?.();
    }

    if (ended) options.live.nudge("share");
  };

  /** A fresh link, its deadline written on both clocks at once. */
  const mintGrant = (share: ActiveShare, name: string): Grant => {
    let token = randomBytes(24).toString("base64url");
    // Uniqueness is an invariant, not a probability: a repeat would keep a
    // revoked token valid through another grant.
    const taken = new Set([...share.grants.values(), ...share.tombstones].map((g) => g.token));

    while (taken.has(token)) token = randomBytes(24).toString("base64url");
    const at = now();

    const grant: Grant = {
      id: randomUUID(),
      name,
      token,
      createdAt: at,
      expiresAt: at + DEFAULT_TTL_MS,
      expiresAtMono: nowMono() + BigInt(DEFAULT_TTL_MS) * 1_000_000n,
      endedAt: null,
      endedBy: null,
      viewers: 0,
    };

    share.grants.set(grant.id, grant);

    return grant;
  };

  /**
   * Which link a token names and whether it stands. An ended link gets its own
   * answer (a lapsed one can be replaced, a revoked one won't come back);
   * anything else is not a link here, without saying whether it ever was.
   */
  const resolve = (
    share: ActiveShare,
    candidate: string,
  ): { grant: Grant } | { refusal: Refusal } => {
    const grant = grantFor(share, candidate);

    if (grant !== null) {
      if (!expired(grant, now(), nowMono())) return { grant };
      endGrant(share, grant, "expiry");
      options.live.nudge("share");

      return { refusal: "expiry" };
    }

    const ended = endedGrantFor(share, candidate);

    if (ended !== null) return { refusal: ended.endedBy === "revoke" ? "revoke" : "expiry" };

    return { refusal: "inactive" };
  };

  /**
   * Gives free slots to whoever is next, one link at a time, so a link with a
   * hundred requests can't block a link with one.
   */
  const pump = (share: ActiveShare): void => {
    while (share.running < VIEWER_CONCURRENCY && share.rota.length > 0) {
      const grantId = share.rota[0];

      if (grantId === undefined) return;
      const next = share.waiting.get(grantId)?.[0];

      if (next === undefined) {
        share.rota.shift();
        share.waiting.delete(grantId);
        continue;
      }

      // The queue removes it, and tidies the link away once it's empty.
      next.drop();
      const turn = share.rota.indexOf(grantId);

      if (turn >= 0) {
        share.rota.splice(turn, 1);
        share.rota.push(grantId);
      }

      // Checked against the clock here, not left to a timer: when a whole queue
      // runs out at once, each request freed by the one ahead would otherwise
      // get a slot with no budget left and be destroyed without a reason.
      if (Date.now() >= next.spentAt) {
        next.shed();
        continue;
      }

      // Checked again: a link revoked while this waited must not get work now.
      if (!share.grants.has(grantId)) {
        refuse(next.req, next.res, "revoke");
        continue;
      }

      next.start();
    }
  };

  /**
   * Puts one viewer request through the ceiling. The slot is held until the
   * response starts, not ends: routing and compiling are the dev server's cost,
   * and holding to `finish` would let twelve SSE streams take every slot for
   * good.
   */
  const admit = (
    share: ActiveShare,
    grant: Grant,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    run: () => void,
  ): void => {
    const queue = share.waiting.get(grant.id) ?? [];

    if (queue.length >= VIEWER_QUEUE) {
      return sendJson(res, 503, { ok: false, error: "Too much at once. Try again." });
    }

    let queued = true;
    let running = false;
    let over = false;
    const spentAt = Date.now() + deadlineMs;

    const shed = (): void => {
      if (over) return;
      over = true;
      sendJson(res, 503, { ok: false, error: "The dev server is busy. Try again." });
    };

    /** One budget for both waits, armed on arrival and disarmed when the response starts. */
    const deadline = setTimeout(() => {
      if (over) return;
      const waited = held.drop();

      if (running) {
        // Destroying the response aborts the request upstream through the
        // proxy's close handling, so the slot goes to someone who can use it.
        over = true;
        res.destroy();
        release();

        return;
      }

      if (waited) shed();
    }, deadlineMs);

    deadline.unref?.();

    /** Headers, finish, close and the deadline can all fire for one request. */
    const release = (): void => {
      if (!running) return;
      running = false;
      over = true;
      clearTimeout(deadline);
      share.running = Math.max(0, share.running - 1);
      pump(share);
    };

    const start = (): void => {
      running = true;
      share.running += 1;
      // No event marks the response starting, so the call that starts it does.
      // The proxy always writes its head before any body.
      const writeHead = res.writeHead.bind(res);
      // SAFETY: Both Node overloads forward their unchanged arguments and return the bound method result.
      res.writeHead = ((...args: Parameters<typeof writeHead>) => {
        release();

        return writeHead(...args);
      }) as typeof res.writeHead;
      res.once("finish", release);
      res.once("close", release);
      run();
    };

    const held: Waiting = {
      req,
      res,
      grantId: grant.id,
      spentAt,
      start,
      shed,
      drop: () => {
        if (!queued) return false;
        queued = false;
        const rest = share.waiting.get(grant.id);
        const at = rest?.indexOf(held) ?? -1;

        if (rest !== undefined && at >= 0) rest.splice(at, 1);

        if (rest !== undefined && rest.length === 0) {
          share.waiting.delete(grant.id);
          const turn = share.rota.indexOf(grant.id);

          if (turn >= 0) share.rota.splice(turn, 1);
        }

        return true;
      },
    };

    queue.push(held);
    share.waiting.set(grant.id, queue);

    if (!share.rota.includes(grant.id)) share.rota.push(grant.id);
    // Synchronous, so a free slot starts the request this tick and the queue
    // only holds what has to wait.
    pump(share);

    if (!queued) return;

    // A viewer who closed the tab must not get a slot later. Revoking answers
    // waiting requests the same way, so this also releases the budget.
    res.once("close", () => {
      held.drop();

      if (running) return;
      over = true;
      clearTimeout(deadline);
    });
  };

  const request = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const share = active;

    if (share === null) return refuse(req, res);
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path.startsWith(ENTRY_PREFIX)) {
      const candidate = path.slice(ENTRY_PREFIX.length);

      if ((req.method !== "GET" && req.method !== "HEAD") || candidate.includes("/")) {
        return refuse(req, res);
      }

      const found = resolve(share, candidate);

      if ("refusal" in found) return refuse(req, res, found.refusal);
      const secure = forwardedProto(req) === "https" ? "; Secure" : "";
      res.writeHead(302, {
        location: "/leglas/",
        "set-cookie": `${SHARE_COOKIE}=${found.grant.token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
        "cache-control": "no-store",
      });
      res.end();

      return;
    }

    const cookie = cookieToken(req);

    if (cookie === null) return refuse(req, res);
    const found = resolve(share, cookie);

    if ("refusal" in found) return refuse(req, res, found.refusal);
    const grant = found.grant;

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 403, {
        ok: false,
        error: "Viewers can look, not change what runs.",
      });
    }

    // A GET that opens an editor is still a write, so it's refused before the
    // proxy sees it.
    if (isDevControlRequest(req.url ?? "/")) {
      return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
    }

    if (isHiddenPath(path)) {
      return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
    }

    // A service worker outlives the share: it stays on the tunnel origin,
    // serves its cache after the link stops and makes its own fetches.
    // Registration is refused. Script can't set this destination, so the signal
    // is trustworthy.
    if (req.headers["sec-fetch-dest"] === "serviceworker") {
      return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
    }

    // Leglas's own paths are the interface, which viewers need; the list is
    // about the app behind it.
    const url = req.url ?? "/";

    // The interface skips the list and the ceiling. Exempting takes the
    // opposite quantifier to refusing: every reading must be safe. Checking
    // only the settled path exempted "//leglas/x" while the router read the raw
    // path and proxied it to the dev server; requiring every spelling includes
    // the raw one, so the two can't disagree.
    const interfaceOwn = spellings(path).every(
      (form) => form === OWN_PREFIX || form.startsWith(`${OWN_PREFIX}/`),
    );

    if (share.reach === "listed" && !interfaceOwn && !routeAllowed(share.routes, url)) {
      // Remembered so the sharer can Allow what their app wanted, since a lazy
      // chunk defeats any list written in advance. The settled path, because
      // that's what Allow adds and how the list reads; a raw spelling would be
      // viewer-chosen and let nothing through.
      const asked = canonical(url.split("?", 1)[0] ?? "/");

      if (!share.refused.includes(asked)) {
        share.refused.push(asked);

        while (share.refused.length > MAX_REFUSED) share.refused.shift();
        options.live.nudge("share");
      }

      return sendJson(res, 403, { ok: false, error: "Not shared." });
    }

    // Counted as running only once it runs, so a waiting request belongs to the
    // queue alone. Revoking destroys running responses and answers waiting
    // ones.
    const run = (): void => {
      // Held so revoking can cut a response that never ends on its own.
      const held = { req, res };
      const inFlight = share.grantRequests.get(grant.id) ?? new Set();
      inFlight.add(held);
      share.grantRequests.set(grant.id, inFlight);
      let released = false;

      const release = (): void => {
        if (released) return;
        released = true;
        share.grantRequests.get(grant.id)?.delete(held);
      };

      res.once("finish", release);
      res.once("close", release);
      options.request(req, res, { publicOrigin: publicOrigin(req), grantId: grant.id });
    };

    // The interface isn't the dev server, so it's never counted or queued. Same
    // settled check as the list, so borrowing the prefix doesn't dodge the
    // ceiling.
    if (interfaceOwn) return run();
    admit(share, grant, req, res, run);
  };

  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const share = active;
    const cookie = cookieToken(req);

    if (share === null || cookie === null) {
      socket.destroy();

      return;
    }

    const found = resolve(share, cookie);

    if ("refusal" in found) {
      socket.destroy();

      return;
    }

    const grant = found.grant;
    // Only the interface's socket. An app's live-reload socket is a two-way
    // channel into the dev server; viewers refresh instead.
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path !== LIVE_PATH) {
      socket.destroy();

      return;
    }

    // A socket arriving through the tunnel proves the link works better than
    // any local probe. One from this machine proves nothing.
    if (throughTunnel(req)) share.runningTunnel?.settle();

    if (!options.upgrade(req, socket, head)) return;
    // Counted per link so the panel can say which is being watched. Kept here
    // because the live hub knows nothing of grants.
    const held = share.grantSockets.get(grant.id) ?? new Set<Duplex>();
    held.add(socket);
    share.grantSockets.set(grant.id, held);
    grant.viewers += 1;
    options.live.nudge("share");
    // A dropped connection can end in `error` and `end` with no `close`, which
    // left the panel counting a viewer who was gone. The live hub releases on
    // the same three.
    let gone = false;

    const letGo = (): void => {
      if (gone) return;
      gone = true;
      share.grantSockets.get(grant.id)?.delete(socket);
      grant.viewers = Math.max(0, grant.viewers - 1);
      options.live.nudge("share");
    };

    socket.once("close", letGo);
    socket.once("end", letGo);
    socket.once("error", letGo);
  };

  const create = async (input: JsonValue | undefined): Promise<ShareResult> => {
    if (closed) return { ok: false, status: 409, error: "Leglas is shutting down." };

    if (active !== null || creating) {
      return { ok: false, status: 409, error: "Stop the current share first." };
    }

    creating = true;
    const stopsAtStart = stops;

    try {
      const previews = await options.previews();
      const parsed = manifestFrom(input, previews);

      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      const providers = await tunnels();
      const requested = isJsonRecord(input) ? input.tunnel : undefined;

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
        // Out of descriptors or no loopback bind: an answer, never an unhandled
        // rejection that takes the proxy down.
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

      if (stops !== stopsAtStart) {
        // A stop arrived while this was finding a port, so the share must not
        // exist.
        await new Promise<void>((resolve) => server.close(() => resolve()));

        return { ok: false, status: 409, error: "Sharing was stopped while it was starting." };
      }

      const share: ActiveShare = {
        ...parsed.manifest,
        id: randomUUID(),
        grants: new Map(),
        tombstones: [],
        port,
        startedAt: now(),
        tunnel: provider === "none" ? { status: "none" } : { status: "starting", provider },
        runningTunnel: null,
        tunnelGeneration: 0,
        server,
        sockets,
        grantSockets: new Map(),
        grantRequests: new Map(),
        launch: null,
        expiryTimer: null,
        refused: [],
        running: 0,
        waiting: new Map(),
        rota: [],
      };

      active = share;
      // A share starts with one link, unnamed until the sharer names it.
      mintGrant(share, "");
      sweepExpiry();
      options.live.nudge("share");

      if (provider !== "none") {
        share.launch = setImmediate(() => {
          share.launch = null;

          if (active !== share) return;
          share.runningTunnel = runTunnel({
            provider,
            port,
            // Whichever link exists when the tunnel starts; the probe only
            // needs a path the listener answers.
            entryPath: `${ENTRY_PREFIX}${Array.from(share.grants.values())[0]?.token ?? ""}`,
            onState: (next) => {
              if (active !== share || JSON.stringify(share.tunnel) === JSON.stringify(next)) return;
              share.tunnel = next;
              options.live.nudge("share");
            },
          });
        });
        share.launch.unref?.();
      }

      return { ok: true, share: snapshot(share) };
    } finally {
      creating = false;
    }
  };

  /** A second link to the same share, named by whoever asks for it. */
  const createGrant = (input: JsonValue | undefined): ShareResult => {
    const share = active;

    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const name = isJsonRecord(input) && isString(input.name) ? input.name.trim() : "";

    if (name.length > 60) {
      return { ok: false, status: 400, error: "That name is too long for a link." };
    }

    sweepExpiry();

    if (share.grants.size >= MAX_GRANTS) {
      return {
        ok: false,
        status: 409,
        error: `A share can hold ${MAX_GRANTS} links. Revoke one to make another.`,
      };
    }

    mintGrant(share, name);
    sweepExpiry();
    options.live.nudge("share");

    return { ok: true, share: snapshot(share) };
  };

  /**
   * Cuts one link without touching the others. It can't reach a rendered page
   * or the browser's caches; it stops what hasn't been served yet.
   */
  const revokeGrant = (input: JsonValue | undefined): ShareResult => {
    const share = active;

    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const id = isJsonRecord(input) && isString(input.id) ? input.id : "";
    const grant = share.grants.get(id);

    if (grant === undefined) return { ok: false, status: 404, error: "No such link." };
    endGrant(share, grant, "revoke");
    sweepExpiry();
    options.live.nudge("share");

    return { ok: true, share: snapshot(share) };
  };

  /**
   * Pushes one link's deadline to a new absolute time, not by an amount, so
   * repeated clicks can't walk it into next week. Live links only; an ended
   * link needs a new one.
   */
  const extendGrant = (input: JsonValue | undefined): ShareResult => {
    const share = active;

    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const id = isJsonRecord(input) && isString(input.id) ? input.id : "";
    sweepExpiry();
    const grant = share.grants.get(id);

    if (grant === undefined) {
      return { ok: false, status: 404, error: "That link has ended. Make a new one." };
    }

    const at = now();
    grant.expiresAt = at + DEFAULT_TTL_MS;
    grant.expiresAtMono = nowMono() + BigInt(DEFAULT_TTL_MS) * 1_000_000n;
    sweepExpiry();
    options.live.nudge("share");

    return { ok: true, share: snapshot(share) };
  };

  /**
   * For a leak the sharer can't place: every link ends and the tunnel is
   * replaced, so the origin changes too.
   */
  const rotate = async (): Promise<ShareResult> => {
    const share = active;

    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };

    for (const grant of Array.from(share.grants.values())) endGrant(share, grant, "revoke");
    const provider = "provider" in share.tunnel ? share.tunnel.provider : null;
    await share.runningTunnel?.stop().catch(() => {});
    share.runningTunnel = null;

    if (active !== share) return { ok: false, status: 404, error: "Nothing is being shared." };
    mintGrant(share, "");
    sweepExpiry();

    if (provider !== null) {
      share.tunnelGeneration += 1;
      const generation = share.tunnelGeneration;
      share.tunnel = { status: "starting", provider };
      share.runningTunnel = runTunnel({
        provider,
        port: share.port,
        entryPath: `${ENTRY_PREFIX}${Array.from(share.grants.values())[0]?.token ?? ""}`,
        onState: (next) => {
          if (active !== share || share.tunnelGeneration !== generation) return;

          if (JSON.stringify(share.tunnel) === JSON.stringify(next)) return;
          share.tunnel = next;
          options.live.nudge("share");
        },
      });
    }

    options.live.nudge("share");

    return { ok: true, share: snapshot(share) };
  };

  /**
   * Lets through a path `listed` refused: a trailing slash for everything
   * beneath it, else the one path. The refusal leaves the list, so the panel
   * empties as the sharer works through it.
   */
  const allowRoute = (input: JsonValue | undefined): ShareResult => {
    const share = active;

    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const given = isJsonRecord(input) && isString(input.path) ? input.path.trim() : "";

    if (!given.startsWith("/")) {
      return { ok: false, status: 400, error: "A route is a path beginning with a slash." };
    }

    // Path or subtree travels with the request, not on a trailing slash, since
    // a refused directory index ends in one and Allow would otherwise grant the
    // subtree.
    const subtree = isJsonRecord(input) && input.subtree === true;

    if (subtree && given.replace(/\/+$/, "") === "") {
      return { ok: false, status: 400, error: "The root is a page, not a folder." };
    }

    const asked = subtree
      ? `${given.replace(/\/+$/, "")}/`
      : given === "/"
        ? given
        : given.replace(/\/+$/, "");

    if (share.routes.length >= 400) {
      return { ok: false, status: 409, error: "That share is holding as many routes as it can." };
    }

    if (!share.routes.includes(asked)) share.routes.push(asked);
    share.refused = share.refused.filter((path) => !routeAllowed([asked], path));
    options.live.nudge("share");

    return { ok: true, share: snapshot(share) };
  };

  const update = async (
    input: JsonValue | undefined,
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
    // Viewers read the config, not the share, so both are nudged.
    options.live.nudge("share");
    options.live.nudge("config");

    return { ok: true, share: snapshot(share) };
  };

  const viewerConfig = async (grantId: string): Promise<ViewerConfig | null> => {
    const share = active;

    if (share === null || !share.grants.has(grantId)) return null;
    const titles = new Set(share.titles);
    const previews = (await options.previews()).filter((preview) => titles.has(preview.title));

    if (active !== share) return null;

    return {
      ...options.viewerConfig,
      // The project id is the config's absolute path and the dev server address
      // names the sharer's network. Viewers keep no layout and never dial the
      // dev server, so they get the share's id and a blank address.
      project: `share:${share.id}`,
      devServer: "",
      previews: options.previewsForConfig(previews),
      errors: [],
      warnings: [],
      viewer: { scope: share.scope, layout: cloneLayout(share.layout) },
    };
  };

  /**
   * A file preview serves its whole directory under a slug from its title, so a
   * guessed slug could reach any mount. Only mounts of shared directions
   * answer.
   */
  const fileSlugAllowed = async (slug: string, grantId: string): Promise<boolean> => {
    const share = active;

    if (share === null || !share.grants.has(grantId)) return false;
    const titles = new Set(share.titles);
    const previews = await options.previews();

    return previews.some((preview) => {
      if (!titles.has(preview.title) || preview.file === undefined) return false;

      const rest = preview.url.startsWith(FILES_PREFIX_PATH)
        ? preview.url.slice(FILES_PREFIX_PATH.length)
        : "";

      const slash = rest.indexOf("/");

      return (slash === -1 ? rest : rest.slice(0, slash)) === slug;
    });
  };

  const stop = (): Promise<void> => {
    stops += 1;

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

  return {
    tunnels,
    status,
    fileSlugAllowed,
    allowRoute,
    create,
    createGrant,
    revokeGrant,
    extendGrant,
    rotate,
    update,
    viewerConfig,
    stop,
    close,
  };
}
