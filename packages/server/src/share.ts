import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { posix } from "node:path";
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
 * How far a viewer may reach into the dev server.
 *
 * `open` is the whole thing over GET, minus the control routes every share
 * refuses. `listed` is only what the share's own list holds, which is the
 * one mechanism here that a page's own JavaScript cannot walk around: it is
 * decided by path on the server, so a console, a service worker and curl
 * all meet it the same way.
 */
export type ShareReach = "open" | "listed";

type ShareManifest = {
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  reach: ShareReach;
  /**
   * Paths a viewer may load in `listed` mode. An entry ending in `/` stands
   * for everything beneath it; anything else is one exact path. Seeded from
   * what the sharer's own browser already loaded for these directions, which
   * is the only honest source: nobody can enumerate a bundler's asset graph
   * by hand, and a list written by guessing breaks the app silently.
   */
  routes: string[];
};

/** How many refusals a share remembers, so the panel can offer to allow them. */
const MAX_REFUSED = 40;

/**
 * Whether the list lets this path through. Compared over every spelling a
 * dev server would answer to, for the same reason the control list is.
 */
export function routeAllowed(routes: readonly string[], url: string): boolean {
  const [rawPath = "/"] = url.split("?", 2);
  const spelled = spellings(rawPath);
  return routes.some((route) => {
    // A trailing slash means a directory, and the root is not one: an app
    // served at "/" would otherwise stand for every path there is, which
    // turns the whole list into "allow anything". Found by a test that
    // expected a refusal and got the app.
    const prefix = route.endsWith("/") && route !== "/";
    return prefix
      ? spelled.some((path) => path.startsWith(route) || `${path}/` === route)
      : spelled.includes(route);
  });
}

export type ShareResult =
  | { ok: true; share: ShareStatus }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

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
  request: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: RequestContext,
  ) => void;
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
  grantRequests: Map<
    string,
    Set<{ req: http.IncomingMessage; res: http.ServerResponse }>
  >;
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

type ShareManager = {
  tunnels(): Promise<TunnelProviderId[]>;
  status(): ShareStatus | null;
  /** Whether a file-preview mount belongs to a direction in the share. */
  fileSlugAllowed(slug: string, grantId: string): Promise<boolean>;
  allowRoute(input: unknown): ShareResult;
  create(input: unknown): Promise<ShareResult>;
  createGrant(input: unknown): ShareResult;
  revokeGrant(input: unknown): ShareResult;
  extendGrant(input: unknown): ShareResult;
  rotate(): Promise<ShareResult>;
  update(input: unknown): Promise<ShareResult>;
  viewerConfig(grantId: string): Promise<unknown | null>;
  stop(): Promise<void>;
  /** Stop, and refuse every share from now on: the server is going. */
  close(): Promise<void>;
};

const ENTRY_PREFIX = "/leglas/s/";
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_GRANTS = 16;
export const MAX_TOMBSTONES = 32;
const NS_PER_MS = 1_000_000n;

/**
 * How many viewer requests may be inside the dev server at once.
 *
 * Not a performance setting, and not a guess. A dev server under load does
 * not fail, it queues inside itself, where nothing here can bound, order,
 * deadline or cancel any of it, and the sharer's own reload joins the back
 * of that queue. Measured on Vite with 200 viewer requests at one instant:
 * unbounded, the sharer's reload took 136ms and the burst ran at 974 req/s;
 * held at twelve, the reload took 21ms and the burst ran at 1415 req/s.
 * Bounding it is faster for everyone, because past saturation the extra
 * concurrency buys no work and costs scheduling.
 *
 * Twelve because a real page load peaked at exactly six requests at once,
 * the browser's per-origin connection cap, so two whole page loads still
 * never wait, and a dev server that parallelises across cores is never the
 * thing being constrained.
 */
export const VIEWER_CONCURRENCY = 12;

/**
 * How many of one link's requests may wait for a slot. Above a full HTTP/2
 * browser burst, since a tunnel hop lifts the six-connection cap. Per link,
 * so one link cannot fill the queue and shed another.
 */
export const VIEWER_QUEUE = 128;

/**
 * How long a viewer request has to begin a response, from arrival, covering
 * waiting for a slot and waiting for the dev server as one budget.
 */
export const VIEWER_DEADLINE_MS = 30_000;

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
 * Every spelling of a path this code must consider, because the dev server
 * behind the proxy does its own matching and does not agree with a plain
 * string compare.
 *
 * Measured: Vite 8.2.2 answers `/__OPEN-IN-EDITOR` from the same middleware
 * as the lowercase one, so a case-sensitive list let a viewer reach the
 * editor launcher. Case is the confirmed gap; the rest of this is the same
 * class, closed while it is open. `//a`, `/./a` and `/x/../a` did not reach
 * Vite's route, but another server is free to normalize before it matches,
 * and refusing a path the app never had costs nothing.
 *
 * Decoding once, not repeatedly: a server that decodes twice is its own
 * bug, and looping here would refuse paths that legitimately contain an
 * encoded percent.
 *
 * A backslash is a slash. Node's own parsers, legacy `url.parse` and the
 * WHATWG `URL` both, turn `/foo\..\x` into `/foo/../x` and the second into
 * `/x`, so a server that reaches for either sees a path this code would not
 * have, unless it looks the same way. Found in a reviewer's probe.
 */
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

/**
 * Whether a request asks for one of those, given the url as the server
 * received it. It takes the whole url rather than the path, because one of
 * these hides in the query.
 */
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
  const reach = value.reach === "listed" ? "listed" : "open";
  if (value.reach !== undefined && value.reach !== "open" && value.reach !== "listed") {
    return { ok: false, error: "Reach is either open or listed." };
  }
  if (value.routes !== undefined && !stringArray(value.routes)) {
    return { ok: false, error: "The route list must be an array of paths." };
  }
  // Only paths, and only ones that could be asked for: a route that does not
  // begin with a slash can never match a request, so it is a mistake worth
  // naming rather than dead weight in the list.
  const routes = [...new Set((value.routes ?? []).map((route) => route.split("?", 1)[0] ?? ""))]
    .filter((route) => route !== "")
    .slice(0, 400);
  if (routes.some((route) => !route.startsWith("/"))) {
    return { ok: false, error: "Every route must be a path beginning with a slash." };
  }
  // The shared directions themselves are always in: a share whose own pages
  // are refused is not a share.
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
 * Find the grant a token names, in constant time across the live ones.
 *
 * The candidate is compared as it was written rather than as it decodes.
 * `Buffer.from(x, "base64url")` drops characters it does not recognise, so
 * decoding first would make a token stand for a family of spellings instead
 * of itself: a trailing invalid character would decode to the same bytes and
 * match. Every grant is compared and none exits early, so the loop tells a
 * caller nothing about how many links exist or which one they hit.
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
 * Whether a link is over, read from two clocks with the earlier winning.
 *
 * A suspended process wakes with a correct wall clock and a monotonic one
 * that under-counted the sleep, so the wall clock is what expires a link
 * across a closed laptop. A wall clock dragged backwards by a correction
 * loses to the monotonic one. Neither can extend a link on its own.
 */
function expired(grant: Grant, now: number, nowMono: bigint): boolean {
  return now >= grant.expiresAt || nowMono >= grant.expiresAtMono;
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
  const html = (Array.isArray(accept) ? accept.join(",") : accept ?? "").includes("text/html");
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
      resolve(typeof address === "object" && address !== null ? address.port : 0);
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
 * Own the one active share. The second listener supplies the security fact:
 * once a request arrives here it is a viewer, even though its peer is local.
 */
export function createShareManager(options: ShareManagerOptions): ShareManager {
  const detect = options.detectTunnels ?? detectTunnels;
  const runTunnel = options.startTunnel ?? startTunnel;
  const now = options.now ?? Date.now;
  /**
   * A clock that cannot be moved. `hrtime` does not advance while the
   * machine sleeps, which is exactly why it is paired with the wall clock
   * rather than trusted alone.
   */
  const nowMono = options.nowMono ?? process.hrtime.bigint;
  const deadlineMs = options.viewerDeadlineMs ?? VIEWER_DEADLINE_MS;
  let detected: Promise<TunnelProviderId[]> | null = null;
  let active: ActiveShare | null = null;
  let creating = false;
  /**
   * Bumped by every stop. A create reads it before it starts and again once
   * it holds a listener, because the two are separated by reading previews,
   * looking for tunnel programs and binding a port, and a stop arriving in
   * there used to find `active` still null, answer that it had stopped and
   * leave the share to come up behind it. Same shape as the `closed` check
   * below it: the work that finished last is the work that undoes itself.
   */
  let stops = 0;
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
    const tunnelUrl = "url" in share.tunnel ? share.tunnel.url : undefined;
    const origin = tunnelUrl === undefined ? null : tunnelUrl.replace(/\/$/, "");
    return {
      id: share.id,
      scope: share.scope,
      titles: [...share.titles],
      layout: cloneLayout(share.layout),
      sharePort: share.port,
      grants: [...share.grants.values()]
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

  /**
   * End one link and let go of everything it is holding.
   *
   * Its sockets go, and so do the proxied requests still running under it. A
   * server-sent events stream is an ordinary GET that never finishes, so
   * letting in-flight responses run to completion would leave somebody who
   * was cut off still receiving. The tombstone is what lets the next request
   * on that token be told which of the two things happened to it.
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
    // Whoever was waiting for a slot under this link gets the same sentence
    // a live request would, rather than a dropped connection.
    for (const held of [...(share.waiting.get(grant.id) ?? [])]) {
      if (held.drop()) refuse(held.req, held.res, why);
    }
    share.waiting.delete(grant.id);
    const turn = share.rota.indexOf(grant.id);
    if (turn >= 0) share.rota.splice(turn, 1);
  };

  /**
   * Drop whatever has run out, then ask again when the next one is due.
   *
   * The timer only makes the end prompt. Whether a link is over is a
   * question about the clock, asked wherever work begins, because a
   * suspended process can wake long past a timer that never fired.
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
    for (const grant of [...share.grants.values()]) {
      if (!expired(grant, at, mono)) continue;
      endGrant(share, grant, "expiry");
      ended = true;
    }
    const next = [...share.grants.values()].reduce<number | null>(
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
    // Unique is an invariant, not a probability: a repeat would leave one
    // token valid through a second grant after the first was revoked.
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
   * Which link a token names, and whether it still stands.
   *
   * A token that no live link answers to may still be one that has ended,
   * and those are two different sentences for the viewer: a link that lapsed
   * can be replaced, one that was turned off will not come back. Anything
   * else is simply not a link here, and says so without confirming whether
   * it ever was.
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
   * Give free slots to whoever is next, one link at a time.
   *
   * Round robin rather than one queue, so a link that arrived with a
   * hundred requests cannot hold the door shut on a link with one.
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
      // Taking it out of the queue is the queue's own job, including
      // tidying this link away once it holds nothing.
      next.drop();
      const turn = share.rota.indexOf(grantId);
      if (turn >= 0) {
        share.rota.splice(turn, 1);
        share.rota.push(grantId);
      }
      // Whether a request still has time is a question about the clock,
      // asked here rather than left to a timer. When a whole queue runs out
      // at once, each request freed by the one ahead of it would otherwise
      // be handed a slot it has no budget left to use, and be destroyed a
      // moment later instead of being told why.
      if (Date.now() >= next.spentAt) {
        next.shed();
        continue;
      }
      // Asked again here rather than trusted from arrival: a link revoked
      // while this waited must not be given work now.
      if (!share.grants.has(grantId)) {
        refuse(next.req, next.res, "revoke");
        continue;
      }
      next.start();
    }
  };

  /**
   * Put one viewer request through the ceiling.
   *
   * The slot is held until the response begins, not until it ends. Routing
   * and compiling is the part that costs the dev server, and it is over when
   * the headers arrive; what streams afterwards is not its work. Holding to
   * `finish` would also deadlock the share on any app using server-sent
   * events, where twelve streams that never end would take every slot and
   * keep it.
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

    /**
     * One budget for both waits, armed on arrival and disarmed when the
     * response begins: a viewer does not care whether the time went on
     * waiting for a slot or on the dev server thinking.
     */
    const deadline = setTimeout(() => {
      if (over) return;
      const waited = held.drop();
      if (running) {
        // Destroying the response aborts the request upstream through the
        // proxy's own close handling, so the slot is given back to somebody
        // who can use it rather than to a request still running.
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
      // No event says "the response began", so the call that begins it says
      // so. The proxy always writes its head before any body.
      const writeHead = res.writeHead.bind(res);
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
    // Synchronous, so a free slot starts the request in this same tick and
    // the queue is only ever a queue when there is something to wait for.
    pump(share);
    if (!queued) return;

    // A viewer who closed the tab must not be given a slot later.
    res.once("close", () => {
      if (!held.drop()) return;
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
    // Everything Leglas serves itself is the interface, which a viewer needs
    // in order to be a viewer at all. The list is about the app behind it.
    const url = req.url ?? "/";
    if (
      share.reach === "listed" &&
      !path.startsWith("/leglas/") &&
      path !== "/leglas" &&
      !routeAllowed(share.routes, url)
    ) {
      // Remembered so the sharer can see what their app wanted and let it
      // in, because no list written in advance survives a lazy chunk.
      const asked = url.split("?", 1)[0] ?? "/";
      if (!share.refused.includes(asked)) {
        share.refused.push(asked);
        while (share.refused.length > MAX_REFUSED) share.refused.shift();
        options.live.nudge("share");
      }
      return sendJson(res, 403, { ok: false, error: "Not shared." });
    }
    // Counted as running only once it actually runs, so that a request still
    // waiting for a slot belongs to the queue alone. Revoking a link cuts
    // the two in different ways: what is running is destroyed mid-response,
    // what is waiting is told why.
    const run = (): void => {
      // Held so revoking this link can cut a response that never ends on its
      // own, and let go however the response finishes.
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
    // The interface is not the dev server, and a viewer needs it in order to
    // be a viewer at all, so it is never counted and never made to wait.
    if (path === "/leglas" || path.startsWith("/leglas/")) return run();
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
    if (!options.upgrade(req, socket, head)) return;
    // The count belongs to the link, so the panel can say which one is being
    // watched. Tracked here rather than in the live hub, which has no
    // business knowing what a grant is.
    const held = share.grantSockets.get(grant.id) ?? new Set<Duplex>();
    held.add(socket);
    share.grantSockets.set(grant.id, held);
    grant.viewers += 1;
    options.live.nudge("share");
    // Three ways a socket goes, and `close` is not always one of them: a
    // viewer whose browser drops the connection can leave an `error` and an
    // `end` with no `close` behind them, which would have left the panel
    // counting somebody who is gone for as long as the share ran. The live
    // hub lets go on the same three, so this follows it.
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

  const create = async (input: unknown): Promise<ShareResult> => {
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
      if (stops !== stopsAtStart) {
        // Somebody asked to stop while this was still finding a port. They
        // are owed the share not existing, so it does not.
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
        tunnel:
          provider === "none"
            ? { status: "none" }
            : { status: "starting", provider },
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
          share.runningTunnel = runTunnel(
            {
              provider,
              port,
              // Whichever link exists when the tunnel starts: the probe only
              // needs a path the listener answers, and a share always has one.
              entryPath: `${ENTRY_PREFIX}${[...share.grants.values()][0]?.token ?? ""}`,
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

  /** A second link to the same share, named by whoever asks for it. */
  const createGrant = (input: unknown): ShareResult => {
    const share = active;
    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const name = isRecord(input) && typeof input.name === "string" ? input.name.trim() : "";
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
    return { ok: true, share: status() as ShareStatus };
  };

  /**
   * Cut one link without disturbing the others.
   *
   * What it cannot reach is worth knowing: a page already rendered, the
   * browser's cache and its back-forward cache are all beyond this. Revoke
   * stops what has not been served yet, which is the promise it can keep.
   */
  const revokeGrant = (input: unknown): ShareResult => {
    const share = active;
    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const id = isRecord(input) && typeof input.id === "string" ? input.id : "";
    const grant = share.grants.get(id);
    if (grant === undefined) return { ok: false, status: 404, error: "No such link." };
    endGrant(share, grant, "revoke");
    sweepExpiry();
    options.live.nudge("share");
    return { ok: true, share: status() as ShareStatus };
  };

  /**
   * Push one link's deadline out again, to a new absolute time rather than
   * by an amount, so repeated clicks cannot walk it into next week unnoticed.
   * Only a live link: an ended one is ended, and the answer to that is a new
   * link, which the sharer has to send anyway.
   */
  const extendGrant = (input: unknown): ShareResult => {
    const share = active;
    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const id = isRecord(input) && typeof input.id === "string" ? input.id : "";
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
    return { ok: true, share: status() as ShareStatus };
  };

  /**
   * For a leak the sharer cannot place: every link ends and the tunnel is
   * replaced, so the origin changes too and no copy of any old address
   * reaches anything.
   */
  const rotate = async (): Promise<ShareResult> => {
    const share = active;
    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    for (const grant of [...share.grants.values()]) endGrant(share, grant, "revoke");
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
        entryPath: `${ENTRY_PREFIX}${[...share.grants.values()][0]?.token ?? ""}`,
        onState: (next) => {
          if (active !== share || share.tunnelGeneration !== generation) return;
          if (JSON.stringify(share.tunnel) === JSON.stringify(next)) return;
          share.tunnel = next;
          options.live.nudge("share");
        },
      });
    }
    options.live.nudge("share");
    return { ok: true, share: status() as ShareStatus };
  };

  /**
   * Let a path through that `listed` turned away.
   *
   * A trailing slash means everything beneath it, which is what a bundler's
   * asset directory wants; anything else is the one path. The refusal it
   * answers leaves the list of what was turned away, so the panel empties as
   * the sharer works through it.
   */
  const allowRoute = (input: unknown): ShareResult => {
    const share = active;
    if (share === null) return { ok: false, status: 404, error: "Nothing is being shared." };
    const asked = isRecord(input) && typeof input.path === "string" ? input.path.trim() : "";
    if (!asked.startsWith("/")) {
      return { ok: false, status: 400, error: "A route is a path beginning with a slash." };
    }
    if (share.routes.length >= 400) {
      return { ok: false, status: 409, error: "That share is holding as many routes as it can." };
    }
    if (!share.routes.includes(asked)) share.routes.push(asked);
    share.refused = share.refused.filter((path) => !routeAllowed([asked], path));
    options.live.nudge("share");
    return { ok: true, share: status() as ShareStatus };
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

  const viewerConfig = async (grantId: string): Promise<unknown | null> => {
    const share = active;
    if (share === null || !share.grants.has(grantId)) return null;
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
  const fileSlugAllowed = async (slug: string, grantId: string): Promise<boolean> => {
    const share = active;
    if (share === null || !share.grants.has(grantId)) return false;
    const titles = new Set(share.titles);
    const previews = await options.previews();
    return previews.some((preview) => {
      if (!titles.has(preview.title) || preview.file === undefined) return false;
      const rest = preview.url.startsWith(FILES_PREFIX_PATH) ? preview.url.slice(FILES_PREFIX_PATH.length) : "";
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
