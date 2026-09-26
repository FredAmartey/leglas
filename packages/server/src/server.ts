import {
  createReadStream,
  existsSync,
  statSync,
  unwatchFile,
  watch as watchFs,
  watchFile,
  type FSWatcher,
} from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { basename, dirname, extname, join, normalize, relative } from "node:path";
import type { Duplex } from "node:stream";

import { parseTemplate } from "./agents/agent-command.js";
import {
  CAPTURES_DIR,
  LOAD_SHARE,
  REFERENCES_DIR,
  attachRequest,
  previewUrl,
  pruneCaptures,
  pruneReferences,
  rehomeCaptures,
  rehomeText,
  sniffImage,
} from "./requests/attachments.js";
import {
  NO_BROWSER,
  createBrowserPool,
  reapOrphanedBrowsers,
  type BrowserPool,
} from "./capture/browser.js";
import { MAX_WIDTH, MIN_WIDTH, capturePage } from "./capture/capture.js";
import {
  createBranchRegistry,
  publicBranchState,
  type BranchPreviewState,
  type StartBranchWorktree,
} from "./branches/branches.js";
import type { ClaudeTurnRunner } from "./agents/claude-agent-session.js";
import type { CodexTurnRunner } from "./agents/codex-app-server.js";
import {
  KNOWN_AGENTS,
  detectAgents,
  isAgentEffort,
  readAgentChoice,
  saveAgentChoice,
  type DetectedAgent,
  type KnownAgentId,
} from "./agents/agents.js";
import { DEFAULT_INSTALL_COMMAND, type LeglasConfig, type Preview } from "./config/config.js";
import { findConfigFile } from "./config/find-config.js";
import {
  LOCAL_PREVIEWS_PATH,
  addLocalPreview,
  dropLocalPreviews,
  readLocalPreviews,
} from "./config/local-previews.js";
import {
  ANNOTATIONS_PATH,
  addAnnotation,
  anchorFrom,
  annotationsFor,
  readAnnotations,
  removeAnnotations,
  updateAnnotation,
} from "./requests/annotations.js";
import { createCoalescer, createLiveHub, type LiveChange, type LiveHub } from "./live.js";
import { checkFraming } from "./frame-policy.js";
import { createProxyHandler } from "./proxy.js";
import { writeRenames } from "./config/renames.js";
import {
  REQUESTS_PATH,
  appendRequest,
  composeRequest,
  isTerminal,
  newRequestId,
  readRequests,
  removeRequest,
  type PendingRequest,
  type RequestMode,
} from "./requests/requests.js";
import { startRunner, type RunnerSpawn, type RunningAgent } from "./agents/runner.js";
import {
  baseOf,
  createGenerations,
  surfaceSlug,
  type GenerationBase,
  type GenerationDeps,
  type Generations,
} from "./generation/generation.js";
import { removeServerInfo, writeServerInfo } from "./server-info.js";
import { createShareManager, type ShareResult } from "./share/share.js";
import {
  detectTunnels as detectShareTunnels,
  startTunnel as startShareTunnel,
} from "./share/tunnel.js";
import type { UpdateService } from "./update.js";

import {
  isBoolean,
  isNumber,
  isString,
  isJsonRecord,
  parseJson,
  type JsonRecord,
  type JsonValue,
} from "./json.js";

/** Everything Leglas owns lives under this prefix; the rest belongs to the app. */
export const LEGLAS_PREFIX = "/leglas";

export const DEFAULT_PORT = 4100;

/** Ports tried before giving up, so a few stale instances do not block startup. */
const PORT_ATTEMPTS = 20;

const REFERENCE_MAX_BYTES = 10_000_000;

/**
 * How long a watch heartbeat counts. Watch beats every 2s, so three beats: one
 * missed beat under load mustn't make the interface flicker, and six seconds of
 * silence means the process is gone.
 */
const ATTACHED_WINDOW_MS = 6000;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isContentExtension(extension: string): extension is keyof typeof CONTENT_TYPES {
  return Object.hasOwn(CONTENT_TYPES, extension);
}

/** Where file-backed previews are served from, under the Leglas prefix. */
export const FILES_PREFIX = `${LEGLAS_PREFIX}/files`;

export type ServerOptions = {
  /** Null when the config failed validation; errors are served instead. */
  config: LeglasConfig | null;
  configErrors?: string[];
  /** Advisory startup findings that should not prevent the interface from loading. */
  configWarnings?: string[];
  port?: number;
  /** Built shell to serve at the prefix. Null serves a placeholder instead. */
  shellDir?: string | null;
  /**
   * Stable project identity the interface keys saved layout on, so a different
   * port doesn't look like a different project and lose rail order and renames.
   */
  project?: string;
  /** Project root, where the request queue is written. */
  cwd?: string;
  /**
   * The running CLI's exact command, used for registration so the agent skips
   * npx discovery and never lands on a cached version with different commands.
   */
  leglasCommand?: string;
  /**
   * Directories served under FILES_PREFIX by mount slug. A file preview renders
   * with no dev server; the whole directory is mounted so sibling assets
   * resolve.
   */
  fileMounts?: ReadonlyMap<string, string>;
  /**
   * Agent detection, injectable so tests don't spawn vendor CLIs; the default
   * probes each CLI's login status.
   */
  detect?: () => Promise<DetectedAgent[]>;
  /**
   * How long one capture may take, injectable so tests needn't wait it out. The
   * load keeps its share of the default either way.
   */
  captureDeadlineMs?: number;
  /** How often the dev server is probed while someone is watching. */
  healthProbeMs?: number;
  /** Persistent Codex transport; null disables it (notably in unit tests). */
  codexAppServer?: CodexTurnRunner | null;
  /** Persistent Claude transport; null disables it (notably in unit tests). */
  claudeAgentSession?: ClaudeTurnRunner | null;
  /** Warm screenshot browser, injectable so HTTP tests never launch a desktop browser. */
  pool?: BrowserPool;
  /** Live change channel, injectable so server tests need no websocket client. */
  live?: LiveHub;
  /** Tunnel discovery and startup, injectable so tests never touch installed providers. */
  detectTunnels?: typeof detectShareTunnels;
  startTunnel?: typeof startShareTunnel;
  /** Branch checkout lifecycle, injectable so server tests need no real git worktree. */
  startWorktree?: StartBranchWorktree;
  /** Generation runs' process spawn, injected by tests so no real agent CLI ever runs. */
  generationSpawn?: RunnerSpawn;
  /**
   * Update checks and installs, from the CLI. Without a service the routes
   * answer 404; the CLI's service also learns the real port for its restart.
   */
  updates?: UpdateService;
};

export type RunningServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};

function sendJson<T>(res: http.ServerResponse, status: number, body: T): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function etagMatches(value: string | string[] | undefined, etag: string): boolean {
  if (value === undefined) return false;
  const values = Array.isArray(value) ? value : [value];

  return values.some((header) =>
    header.split(",").some((candidate) => {
      const tag = candidate.trim();

      return tag === "*" || tag === etag || tag === `W/${etag}`;
    }),
  );
}

/** Serialize once, then derive and answer from those exact bytes. */
function sendConditionalJson<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: T,
): void {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("base64url")}"`;

  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, { etag, "cache-control": "private, no-cache" });
    res.end();

    return;
  }

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-cache",
    etag,
  });
  res.end(payload);
}

/** How long one `show --screenshot` may take, and how much of that the load may use. */
const CAPTURE_DEADLINE_MS = 15_000;

const CAPTURE_LOAD_MS = Math.floor(CAPTURE_DEADLINE_MS * LOAD_SHARE);

function captureSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "direction"
  );
}

function referenceName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

  const safe = [...raw]
    .filter((character) => {
      const code = character.charCodeAt(0);

      return code >= 0x20 && code <= 0x7e && character !== "/" && character !== "\\";
    })
    .join("")
    .trim()
    .slice(0, 80);

  return safe || "image";
}

function isAddressInUse(cause: unknown): cause is { code: "EADDRINUSE" } {
  return (
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
  );
}

function isKnownAgent(value: unknown): value is KnownAgentId {
  return isString(value) && Object.hasOwn(KNOWN_AGENTS, value);
}

/**
 * Only the machine itself may mutate. The API decides what runs on this
 * computer, so writers are decided by the socket, which a network peer can't
 * forge: every POST needs a loopback peer. Headers prove nothing, and Origin is
 * only browser-enforced. The Origin check below isn't authentication; it
 * defends the local browser against cross-site and DNS-rebinding pages. When
 * present it must match Host, and Host must be a name this machine would reach
 * itself by. LAN teammates can still open and view shared directions.
 */
function isAllowedMutationHost(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1") return true;

  if (bare.endsWith(".local")) return true;

  if (!net.isIPv4(bare)) return false;

  const [first, second] = bare.split(".").map(Number);

  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;

  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

export function isTrustedMutation(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;

  if (!isString(req.headers.host)) return false;

  let host: URL;

  try {
    host = new URL(`http://${req.headers.host}`);
  } catch {
    return false;
  }

  if (!isAllowedMutationHost(host.hostname)) return false;

  const rawOrigin = req.headers.origin;

  if (rawOrigin === undefined) return true;

  try {
    const origin = new URL(rawOrigin);

    return origin.protocol === "http:" && origin.host === host.host;
  } catch {
    return false;
  }
}

/**
 * Whether a request is over, by either record. The runner knows what it ran;
 * the queue file knows what happened across restarts. A request that ended
 * before this process started has only the file, and still needs a rerun button
 * and a dismiss.
 */
function isEnded(request: PendingRequest, failedIds: readonly string[]): boolean {
  return isTerminal(request.status) || failedIds.includes(request.id);
}

/**
 * A request body as the object a route expects, or null. `JSON.parse("null")`
 * succeeds and the next property read throws in a listener nobody awaits, so
 * four characters from a local client could end the process. Arrays and bare
 * numbers are valid JSON and just as wrong. Each route checks the fields it
 * uses.
 */
function jsonBody(body: string): JsonRecord | null {
  try {
    const parsed = parseJson(body || "{}");

    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The words of a request, trimmed; null when the body sent something that is not text. */
function requestIntent(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return "";

  return isString(value) ? value.trim() : null;
}

function hasJsonBody(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];

  return (
    isString(contentType) &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

/**
 * Whether the dev server accepts connections. TCP, not HTTP: a framework
 * mid-compile accepts the socket long before it answers, and starting up should
 * count as reachable.
 */
export function probe(target: string, timeoutMs = 1000): Promise<boolean> {
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

/** Serve one file from inside a directory, refusing anything that escapes it. */
function serveFrom(res: http.ServerResponse, dir: string, relativePath: string): boolean {
  const relative = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(dir, relative);

  if (!candidate.startsWith(dir)) return false;

  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;

  const extension = extname(candidate);
  res.writeHead(200, {
    "content-type": isContentExtension(extension)
      ? CONTENT_TYPES[extension]
      : "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(candidate).pipe(res);

  return true;
}

function serveShellFile(res: http.ServerResponse, shellDir: string, urlPath: string): boolean {
  // normalize() collapses ".." before it can leave the shell directory.
  const relative = normalize(urlPath.slice(LEGLAS_PREFIX.length)).replace(/^(\.\.[/\\])+/, "");
  // normalize("") is ".", and "/leglas" and "/leglas/" both mean the root, so
  // all three serve index.html.
  const isRoot = relative === "" || relative === "." || relative === "/";

  return serveFrom(res, shellDir, isRoot ? "index.html" : relative);
}

type ConfigSnapshot = { path: string; mtimeMs: number } | null;

const HEALTH_PROBE_MS = 3000;

type LiveFiles = {
  close(): void;
};

type WatchedTarget = {
  path: string;
  change: LiveChange;
};

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);

    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Watches the file-backed pieces the shell re-reads after a nudge. `.leglas` is
 * watched as a directory, not four file handles, so atomic replacements work;
 * its parent is watched too, since `.leglas` may appear later.
 */
function watchLiveFiles(cwd: string, configPath: string | null, live: LiveHub): LiveFiles {
  const leglasDir = join(cwd, ".leglas");

  const targets = [
    { path: join(cwd, LOCAL_PREVIEWS_PATH), change: "config" },
    { path: join(cwd, REQUESTS_PATH), change: "requests" },
    { path: join(cwd, ANNOTATIONS_PATH), change: "requests" },
  ] satisfies WatchedTarget[];

  const byName = new Map(targets.map((target) => [basename(target.path), target]));
  const known = new Map(targets.map((target) => [target.path, fileStamp(target.path)]));
  const coalescer = createCoalescer((change) => live.nudge(change));
  const watchers = new Set<FSWatcher>();
  const fallback = new Map<string, () => void>();
  let leglasWatcher: FSWatcher | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const nudgeSoon = (change: LiveChange): void => coalescer.schedule(change);

  const scanLeglas = (notify: boolean): void => {
    for (const target of targets) {
      const next = fileStamp(target.path);

      if (next === known.get(target.path)) continue;
      known.set(target.path, next);

      if (notify) nudgeSoon(target.change);
    }
  };

  /**
   * Stat-polls a file only when its native watcher failed or died. The case is
   * a filesystem where `fs.watch` never fires (network mounts, some container
   * bind mounts); without this those setups get no nudges and wait out the
   * shell's 15s fallback. Every caller is an error handler; with a working
   * `fs.watch`, nothing is polled.
   */
  const fallbackWatch = (target: WatchedTarget): void => {
    if (closed || fallback.has(target.path)) return;

    const listener = (): void => {
      const next = fileStamp(target.path);

      if (next === known.get(target.path)) return;
      known.set(target.path, next);
      nudgeSoon(target.change);
    };

    fallback.set(target.path, listener);
    watchFile(target.path, { persistent: false, interval: 250 }, listener);
  };

  const fallbackLeglas = (): void => {
    for (const target of targets) fallbackWatch(target);
  };

  const retryLeglas = (): void => {
    if (closed || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      armLeglas(true);
    }, 250);
    retry.unref?.();
  };

  const armLeglas = (notify: boolean): void => {
    if (closed) return;
    scanLeglas(notify);
    let directory = false;

    try {
      directory = statSync(leglasDir).isDirectory();
    } catch {
      directory = false;
    }

    if (!directory) {
      if (leglasWatcher !== null) {
        watchers.delete(leglasWatcher);
        leglasWatcher.close();
        leglasWatcher = null;
      }

      // Look again shortly. Until then only the parent watcher would notice
      // `.leglas` being created, and one missed event there would leave the
      // state directory unwatched for the session with no sign why. Short in
      // practice: the server writes its rendezvous file into `.leglas` on
      // listen.
      retryLeglas();

      return;
    }

    if (leglasWatcher !== null) return;

    try {
      const watcher = watchFs(leglasDir, { persistent: false }, (_event, filename) => {
        if (filename === null) {
          scanLeglas(true);

          return;
        }

        const name = Buffer.isBuffer(filename) ? filename.toString() : filename;
        const target = byName.get(name);

        if (target === undefined) return;
        known.set(target.path, fileStamp(target.path));
        nudgeSoon(target.change);
      });

      watcher.on("error", () => {
        if (leglasWatcher !== watcher) return;
        watchers.delete(watcher);
        watcher.close();
        leglasWatcher = null;
        fallbackLeglas();
        retryLeglas();
      });
      leglasWatcher = watcher;
      watchers.add(watcher);
    } catch {
      fallbackLeglas();
      retryLeglas();
    }
  };

  // Re-arm the inner watcher whenever the state directory is created, removed
  // or replaced. Failures are silent; the shell's fallback read is the source
  // of truth.
  try {
    const watcher = watchFs(cwd, { persistent: false }, (_event, filename) => {
      const name =
        filename === null ? null : Buffer.isBuffer(filename) ? filename.toString() : filename;

      if (name === null || name === ".leglas") armLeglas(true);
    });

    watcher.on("error", () => {
      watchers.delete(watcher);
      watcher.close();
      fallbackLeglas();
    });
    watchers.add(watcher);
  } catch {
    fallbackLeglas();
    // Only an acceleration; the endpoints still read files directly.
  }

  if (configPath !== null) {
    try {
      const directory = dirname(configPath);
      const name = basename(configPath);
      const target = { path: configPath, change: "config" } satisfies WatchedTarget;
      known.set(configPath, fileStamp(configPath));

      const watcher = watchFs(directory, { persistent: false }, (_event, filename) => {
        const changed =
          filename === null ? null : Buffer.isBuffer(filename) ? filename.toString() : filename;

        if (changed === null || changed === name) nudgeSoon("config");
      });

      watcher.on("error", () => {
        watchers.delete(watcher);
        watcher.close();
        fallbackWatch(target);
      });
      watchers.add(watcher);
    } catch {
      fallbackWatch({ path: configPath, change: "config" });
      // A missing or unwatchable config does not make the server unavailable.
    }
  }

  armLeglas(false);

  return {
    close: () => {
      if (closed) return;
      closed = true;

      if (retry !== null) clearTimeout(retry);
      coalescer.close();

      for (const watcher of watchers) watcher.close();
      watchers.clear();

      for (const [path, listener] of fallback) unwatchFile(path, listener);
      fallback.clear();
      leglasWatcher = null;
    },
  };
}

type HealthWatch = LiveFiles & {
  /** The last verdict, or null while nobody is listening and nothing has been asked. */
  reachable(): boolean | null;
};

function watchHealth(target: string, live: LiveHub, intervalMs: number): HealthWatch {
  let previous: boolean | null = null;
  let probing = false;
  let closed = false;

  const timer = setInterval(() => {
    if (live.listening === 0) {
      previous = null;

      return;
    }

    if (probing) return;
    probing = true;
    void probe(target)
      .then((reachable) => {
        if (closed || live.listening === 0) {
          previous = null;

          return;
        }

        if (previous !== null && previous !== reachable) live.nudge("health");
        previous = reachable;
      })
      .finally(() => {
        probing = false;
      });
  }, intervalMs);

  timer.unref?.();

  return {
    close: () => {
      closed = true;
      clearInterval(timer);
    },
    reachable: () => previous,
  };
}

function snapshotConfig(cwd: string): ConfigSnapshot {
  const path = findConfigFile(cwd);

  if (path === null) return null;

  try {
    return { path, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function configStalenessNotice(
  cwd: string,
  boot: ConfigSnapshot,
  current: ConfigSnapshot,
): string | null {
  if (boot === null && current === null) return null;

  if (boot === null && current !== null) {
    const label = relative(cwd, current.path) || current.path;

    return `${label} appeared after Leglas started. Restart leglas to pick it up.`;
  }

  if (boot !== null && current === null) {
    const label = relative(cwd, boot.path) || boot.path;

    return `${label} was removed after Leglas started. Restart leglas to run without it.`;
  }

  if (
    boot !== null &&
    current !== null &&
    (boot.path !== current.path || boot.mtimeMs !== current.mtimeMs)
  ) {
    const label = relative(cwd, current.path) || current.path;

    return `${label} changed after Leglas started. Restart leglas to pick it up.`;
  }

  return null;
}

const PLACEHOLDER = `<!doctype html>
<meta charset="utf-8">
<title>Leglas</title>
<body style="font:14px/1.6 ui-sans-serif,system-ui;padding:3rem;max-width:34rem">
<h1 style="font-size:1rem">Leglas</h1>
<p>The server is running and proxying your app. The interface has not been
built into this install yet.</p>
<p><a href="/leglas/api/config">/leglas/api/config</a> ·
<a href="/leglas/api/health">/leglas/api/health</a> ·
<a href="/leglas/api/requests">/leglas/api/requests</a></p>
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
      resolve(address !== null && !isString(address) ? address.port : port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Binds the requested port, or the next free one, so a stale instance on 4100
 * doesn't stop startup; it says where it started.
 */
async function bind(server: http.Server, requested: number): Promise<number> {
  if (requested === 0) return listen(server, 0);

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    try {
      return await listen(server, requested + attempt);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }

  throw new Error(`No free port between ${requested} and ${requested + PORT_ATTEMPTS - 1}.`);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const {
    config,
    configErrors = [],
    configWarnings = [],
    shellDir = null,
    project = "",
    cwd = process.cwd(),
    leglasCommand = "npx -y leglas",
    fileMounts = new Map<string, string>(),
    detect = () => detectAgents(),
    captureDeadlineMs = CAPTURE_DEADLINE_MS,
    healthProbeMs = HEALTH_PROBE_MS,
  } = options;

  const browserPool = options.pool ?? createBrowserPool();
  let shares: ReturnType<typeof createShareManager> | null = null;
  let liveHealth: HealthWatch | null = null;
  const live: LiveHub = options.live ?? createLiveHub();

  const branchOptions: Parameters<typeof createBranchRegistry>[0] = {
    cwd,
    previews: (config?.previews ?? []).flatMap((preview) =>
      preview.branch === undefined ? [] : [{ title: preview.title, branch: preview.branch }],
    ),
    installCommand: config?.installCommand ?? DEFAULT_INSTALL_COMMAND,
    devCommand: config?.devCommand,
    onChange: () => live.nudge("config"),
  };

  if (options.startWorktree !== undefined) branchOptions.startWorktree = options.startWorktree;
  const branches = createBranchRegistry(branchOptions);

  type ConfigPreview =
    | Preview
    | (Omit<Preview, "url"> & {
        url?: string;
        state: BranchPreviewState;
      });

  const previewForConfig = (preview: Preview): ConfigPreview => {
    if (preview.branch === undefined) return preview;
    const state = branches.state(preview.title) ?? { status: "idle" as const };
    const { url: route, ...withoutUrl } = preview;
    const branchUrl = branches.url(preview.title);

    return state.status === "ready"
      ? {
          ...withoutUrl,
          url: `${branchUrl ?? state.worktree.url}${route}`,
          state: publicBranchState(state),
        }
      : { ...withoutUrl, state: publicBranchState(state) };
  };

  const previewsForConfig = (previews: readonly Preview[]) => previews.map(previewForConfig);

  const readyPreview = (preview: Preview): Preview | null => {
    if (preview.branch === undefined) return preview;
    const state = branches.state(preview.title);

    return state?.status === "ready"
      ? { ...preview, url: `${branches.url(preview.title) ?? state.worktree.url}${preview.url}` }
      : null;
  };

  // Sweep up browsers from a Leglas killed outright or crashed. Not awaited,
  // since a slow temp directory mustn't hold up the interface. A live Leglas's
  // browser is left alone; see reapOrphanedBrowsers.
  if (options.pool === undefined) {
    void reapOrphanedBrowsers().catch(() => {});
  }

  const target = config?.devServer ?? "http://localhost:3000";
  const proxy = createProxyHandler({ target });
  // Boot config is frozen on purpose; this snapshot lets the live endpoint say
  // when it's stale.
  const bootConfigPath = findConfigFile(cwd);
  const bootConfigSnapshot = snapshotConfig(cwd);

  /**
   * When watch last said it was listening, in memory only: a file would outlive
   * the watcher and promise an agent that's gone.
   */
  let lastSeen: number | null = null;
  const externallyAttached = () => lastSeen !== null && Date.now() - lastSeen < ATTACHED_WINDOW_MS;
  let runner: RunningAgent | null = null;
  let generations: Generations | null = null;

  /**
   * Detection asks every vendor CLI for its login status (about a second), so
   * ordinary reads use a short cache. Opening the picker asks for a fresh
   * answer and waits, so a newly installed or signed-in CLI shows on that look.
   */
  let agentsCache: { at: number; agents: DetectedAgent[] } | null = null;
  let agentsInflight: Promise<DetectedAgent[]> | null = null;
  const AGENTS_FRESH_MS = 30_000;

  const probeAgents = (): Promise<DetectedAgent[]> => {
    agentsInflight ??= detect()
      .then((agents) => {
        agentsCache = { at: Date.now(), agents };

        return agents;
      })
      .finally(() => {
        agentsInflight = null;
      });

    return agentsInflight;
  };

  const currentAgents = (refresh = false): Promise<DetectedAgent[]> => {
    if (refresh || agentsCache === null) {
      return probeAgents();
    }

    // Login state can change with the interface open, but a routine read
    // needn't wait on every CLI. Serve the last answer and refresh in the
    // background; the picker still uses refresh=1 and waits.
    if (Date.now() - agentsCache.at > AGENTS_FRESH_MS) {
      void probeAgents().catch(() => {
        // A failed refresh leaves the last successful answer intact.
      });
    }

    return Promise.resolve(agentsCache.agents);
  };

  /**
   * Resolves against the same live registry the rail polls, by the same rule. A
   * direction added after boot joins only as a plain URL: a branch needs its
   * checkout and a file its mount, both built at boot, so capturing a fresh one
   * would load the wrong page. The rail holds those until the restart the CLI
   * asks for.
   */
  const livePreviewDefinitions = async (): Promise<Preview[]> => {
    const localRead = await readLocalPreviews(cwd).catch(() => null);
    const local = localRead?.errors.length === 0 ? localRead.previews : [];
    const localTitles = new Set(local.map((entry) => entry.title));
    const bootConfig = config?.previews ?? [];

    const boot =
      localRead === null || localRead.errors.length > 0
        ? bootConfig
        : bootConfig.filter((entry) => entry.local !== true || localTitles.has(entry.title));

    const known = new Set(boot.map((entry) => entry.title));

    const fresh = local.filter(
      (entry) => !known.has(entry.title) && entry.branch === undefined && entry.file === undefined,
    );

    return [...boot, ...fresh];
  };

  const livePreviews = async (): Promise<Preview[]> =>
    (await livePreviewDefinitions()).map(readyPreview).filter((preview) => preview !== null);

  // Start detection before the browser asks, overlapping CLI login checks with
  // shell loading; an early API read joins the same promise.
  void probeAgents().catch(() => {
    // The endpoint can retry on demand; startup itself must stay available.
  });

  /**
   * Reads a JSON object, hands it to a share write and answers with its result.
   * The body is refused before the write, as every POST here does.
   */
  const readShareBody = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    run: (body: JsonRecord) => ShareResult | Promise<ShareResult> | undefined,
  ): void => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = jsonBody(body);

      if (parsed === null) return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
      void Promise.resolve(run(parsed)).then((result) => {
        if (result === undefined) {
          return sendJson(res, 500, { ok: false, error: "Sharing is not available." });
        }

        return result.ok
          ? sendJson(res, 200, result)
          : sendJson(res, result.status, { ok: false, error: result.error });
      });
    });
  };

  /**
   * A generate route's body: JSON or a 400, and a 503 until the generations
   * exist. One call per route, so the scan in server.test.ts sees each of them.
   */
  const readGenerationBody = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    run: (body: JsonRecord, running: Generations) => void | Promise<void>,
  ): void => {
    if (!hasJsonBody(req)) {
      return sendJson(res, 400, { ok: false, error: "A generation request must be JSON." });
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = jsonBody(body);

      if (parsed === null) return sendJson(res, 400, { ok: false, error: "Body must be JSON." });

      if (generations === null)
        return sendJson(res, 503, { ok: false, error: "Leglas is still starting." });
      void run(parsed, generations);
    });
  };

  /** Stop, retry or replace: a set by its id, and a direction by its slot. */
  const actOnGeneration = async (
    res: http.ServerResponse,
    action: string,
    parsed: JsonRecord,
    act: (id: string, slot: string | undefined) => boolean | Promise<boolean>,
  ): Promise<void> => {
    if (!isString(parsed.id) || (parsed.slot !== undefined && !isString(parsed.slot))) {
      return sendJson(res, 400, {
        ok: false,
        error: "Name the generation by its id, and the direction by its slot.",
      });
    }

    const done = await act(parsed.id, isString(parsed.slot) ? parsed.slot : undefined);

    return done
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 409, { ok: false, error: `Nothing to ${action} there right now.` });
  };

  const handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: { remote: boolean; publicOrigin: string; grantId?: string },
  ): void => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");

    // Anything but a read counts as a mutation, whatever routes exist today.
    if (
      !context.remote &&
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      path.startsWith(`${LEGLAS_PREFIX}/api/`) &&
      !isTrustedMutation(req)
    ) {
      return sendJson(res, 403, { ok: false, error: "Cross-origin API mutations are refused." });
    }

    if (context.remote && path === `${LEGLAS_PREFIX}/api/config`) {
      return void shares?.viewerConfig(context.grantId ?? "").then((payload) => {
        if (payload === null) {
          return sendJson(res, 403, { ok: false, error: "This link isn't active." });
        }

        sendConditionalJson(req, res, payload);
      });
    }

    if (context.remote && path === `${LEGLAS_PREFIX}/api/health`) {
      // Only the verdict, the one the watcher holds: viewers all ask on the
      // watcher's nudge, so a probe each would be that many sockets for one
      // answer. The full answer names the working directory and dev server
      // address, which viewers have no business with.
      const known = liveHealth?.reachable() ?? null;

      return void (known === null ? probe(target) : Promise.resolve(known)).then((reachable) =>
        sendConditionalJson(req, res, { reachable }),
      );
    }

    if (context.remote && path.startsWith(`${LEGLAS_PREFIX}/api/`)) {
      return sendJson(res, 403, { error: "Not available to viewers." });
    }

    if (path === `${LEGLAS_PREFIX}/api/generate` && req.method === "GET") {
      return sendJson(res, 200, { ok: true, jobs: generations?.snapshot() ?? [] });
    }

    if (path === `${LEGLAS_PREFIX}/api/generate` && req.method === "POST") {
      return void readGenerationBody(req, res, async (parsed, running) => {
        if (!isString(parsed.surface) || !isString(parsed.brief)) {
          return sendJson(res, 400, {
            ok: false,
            error: "Name a surface and describe the directions in a brief.",
          });
        }

        let basedOn: GenerationBase | null = null;

        // Variations name their direction as the rail does; its switch key is
        // in its address.
        if (parsed.basedOn !== undefined && parsed.basedOn !== null && parsed.basedOn !== "") {
          const title = parsed.basedOn;

          const preview = isString(title)
            ? (await livePreviews()).find((entry) => entry.title === title)
            : undefined;

          basedOn = preview === undefined ? null : baseOf(preview, parsed.surface);

          if (basedOn === null) {
            return sendJson(res, 422, {
              ok: false,
              error: `${isString(title) ? title : "That"} is not a direction of the ${surfaceSlug(parsed.surface)}, so Leglas cannot build variations of it.`,
            });
          }
        }

        const started = await running.start({
          surface: parsed.surface,
          brief: parsed.brief,
          count: isNumber(parsed.count) ? parsed.count : 3,
          agent: await readAgentChoice(cwd),
          basedOn,
        });

        return started.ok
          ? sendJson(res, 202, { ok: true, job: started.job })
          : sendJson(res, 422, { ok: false, error: started.error });
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/generate/stop` && req.method === "POST") {
      return void readGenerationBody(req, res, (parsed, running) =>
        actOnGeneration(res, "stop", parsed, (id, slot) => running.stop(id, slot)),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/generate/retry` && req.method === "POST") {
      return void readGenerationBody(req, res, (parsed, running) =>
        actOnGeneration(res, "retry", parsed, (id, slot) =>
          slot === undefined ? false : running.retry(id, slot),
        ),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/generate/replace` && req.method === "POST") {
      return void readGenerationBody(req, res, (parsed, running) =>
        actOnGeneration(res, "replace", parsed, (id, slot) =>
          slot === undefined ? false : running.replace(id, slot),
        ),
      );
    }

    if (
      (path === `${LEGLAS_PREFIX}/api/update` && req.method === "GET") ||
      (req.method === "POST" &&
        ["check", "skip", "install"].some(
          (action) => path === `${LEGLAS_PREFIX}/api/update/${action}`,
        ))
    ) {
      const updates = options.updates;

      if (updates === undefined) {
        return sendJson(res, 404, { ok: false, error: "Updates are not available here." });
      }

      if (req.method === "GET") return sendJson(res, 200, updates.status());

      if (path.endsWith("/check")) {
        return void updates.check({ force: true }).then((status) => sendJson(res, 200, status));
      }

      if (path.endsWith("/install")) {
        return void updates.update().then(
          (status) => sendJson(res, 200, status),
          (cause: unknown) =>
            sendJson(res, 409, {
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        );
      }

      if (!hasJsonBody(req)) return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", () => {
        const parsed = jsonBody(body);

        if (parsed === null) return sendJson(res, 400, { ok: false, error: "Body must be JSON." });

        if (!isString(parsed.version) || parsed.version.trim() === "") {
          return sendJson(res, 400, { ok: false, error: "Body needs a version." });
        }

        void updates.skip(parsed.version).then(
          (status) => sendJson(res, 200, status),
          (cause: unknown) =>
            sendJson(res, 400, {
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        );
      });
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share` && req.method === "GET") {
      return void shares
        ?.tunnels()
        .then((tunnels) => sendJson(res, 200, { share: shares?.status() ?? null, tunnels }));
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Share details must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        const result = await shares?.create(parsed).catch((cause: unknown) => ({
          ok: false as const,
          status: 500 as const,
          error: `Leglas could not start the share (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
        }));

        if (result === undefined) {
          return sendJson(res, 500, { ok: false, error: "Sharing is not available." });
        }

        return result.ok
          ? sendJson(res, 200, result)
          : sendJson(res, result.status, { ok: false, error: result.error });
      });
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share/update` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Share details must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        const result = await shares?.update(parsed);

        if (result === undefined) {
          return sendJson(res, 500, { ok: false, error: "Sharing is not available." });
        }

        return result.ok
          ? sendJson(res, 200, result)
          : sendJson(res, result.status, { ok: false, error: result.error });
      });
    }

    // Written out, not looped, because the body guard's test finds POST routes
    // by this exact shape. A route it can't see goes unchecked.
    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share/grants` && req.method === "POST") {
      return void readShareBody(req, res, (body) => shares?.createGrant(body));
    }

    if (
      !context.remote &&
      path === `${LEGLAS_PREFIX}/api/share/grants/revoke` &&
      req.method === "POST"
    ) {
      return void readShareBody(req, res, (body) => shares?.revokeGrant(body));
    }

    if (
      !context.remote &&
      path === `${LEGLAS_PREFIX}/api/share/grants/extend` &&
      req.method === "POST"
    ) {
      return void readShareBody(req, res, (body) => shares?.extendGrant(body));
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share/allow` && req.method === "POST") {
      return void readShareBody(req, res, (body) => shares?.allowRoute(body));
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share/rotate` && req.method === "POST") {
      return void readShareBody(req, res, () => shares?.rotate());
    }

    if (!context.remote && path === `${LEGLAS_PREFIX}/api/share/stop` && req.method === "POST") {
      return void (shares?.stop() ?? Promise.resolve()).then(() =>
        sendJson(res, 200, { ok: true }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/config`) {
      // Local previews are re-read per request, so a direction registered with
      // the interface open appears without a restart. Only plain url previews
      // join live; branches and files wait for the restart the CLI mentions. A
      // local file that fails to read or validate changes nothing.
      const boot = config?.previews ?? [];
      const errors = [...configErrors];
      const notice = configStalenessNotice(cwd, bootConfigSnapshot, snapshotConfig(cwd));

      if (notice !== null) errors.push(notice);

      return void readLocalPreviews(cwd)
        .then(({ previews: local, errors: localErrors }) => {
          if (localErrors.length > 0) {
            return sendConditionalJson(req, res, {
              project,
              devServer: target,
              scanPreviews: config?.scanPreviews ?? true,
              previews: previewsForConfig(boot),
              errors,
              warnings: configWarnings,
            });
          }

          const localTitles = new Set(local.map((preview) => preview.title));

          // Local directions present at boot stay fully resolved, mounts and
          // branch servers included, and leave the payload as soon as they're
          // deleted from the registry.
          const currentBoot = boot.filter(
            (preview) => preview.local !== true || localTitles.has(preview.title),
          );

          const known = new Set(currentBoot.map((preview) => preview.title));

          const fresh = local.filter(
            (preview) =>
              !known.has(preview.title) &&
              preview.branch === undefined &&
              preview.file === undefined,
          );

          sendConditionalJson(req, res, {
            project,
            devServer: target,
            scanPreviews: config?.scanPreviews ?? true,
            previews: previewsForConfig([...currentBoot, ...fresh]),
            errors,
            warnings: configWarnings,
          });
        })
        .catch(() =>
          sendConditionalJson(req, res, {
            project,
            devServer: target,
            scanPreviews: config?.scanPreviews ?? true,
            previews: previewsForConfig(boot),
            errors,
            warnings: configWarnings,
          }),
        );
    }

    if (path === `${LEGLAS_PREFIX}/api/previews/framing` && req.method === "GET") {
      // Only the interface or a terminal asks. A page elsewhere in the browser
      // couldn't read the answer but could make Leglas fetch, so cross-site
      // callers are refused first.
      const site = req.headers["sec-fetch-site"];

      if (site !== undefined && site !== "same-origin" && site !== "none") {
        return sendJson(res, 403, { ok: false, error: "Only the interface can ask this." });
      }

      const title = query.get("title");

      return void livePreviewDefinitions().then(async (previews) => {
        const preview = previews.find((entry) => entry.title === title);

        if (preview === undefined) {
          return sendJson(res, 404, { ok: false, error: "There is no direction by that name." });
        }

        // Only a page the frame loads straight from its own address can refuse
        // framing. Everything else goes through Leglas, and viewers never get
        // here.
        if (
          preview.file !== undefined ||
          preview.branch !== undefined ||
          !/^https?:\/\//i.test(preview.url)
        ) {
          return sendJson(res, 200, { framable: true });
        }

        // The address is the project's own (config or local previews, where
        // `devCommand` comes from too). The capture browser already loads this
        // URL for every request's frame, so asking for headers reaches nothing
        // new, and only a verdict comes back.
        //
        // The embedder is the interface as this browser reached it.
        const embedder = `http://${req.headers.host ?? "localhost"}${LEGLAS_PREFIX}/`;

        sendJson(res, 200, await checkFraming(preview.url, embedder));
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/previews/start` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.title) || parsed.title.trim() === "") {
          return sendJson(res, 400, { ok: false, error: "Body needs a direction title." });
        }

        const preview = (await livePreviewDefinitions()).find(
          (entry) => entry.title === parsed.title,
        );

        if (preview === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such direction." });
        }

        if (preview.branch === undefined) {
          return sendJson(res, 400, {
            ok: false,
            error: `"${preview.title}" is not a branch preview.`,
          });
        }

        if (config?.devCommand === undefined) {
          return sendJson(res, 400, {
            ok: false,
            error: `"${preview.title}" cannot start because the config sets no devCommand.`,
          });
        }

        void branches.start(preview.title);
        const state = branches.state(preview.title);

        if (state === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such branch preview." });
        }

        return sendJson(res, 200, { ok: true, state: publicBranchState(state) });
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/previews/delete` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        const titles = parsed.titles;

        if (
          !Array.isArray(titles) ||
          titles.length === 0 ||
          !titles.every((title): title is string => isString(title) && title.trim() !== "")
        ) {
          return sendJson(res, 400, {
            ok: false,
            error: "Body needs a non-empty array of direction titles.",
          });
        }

        const unique = [...new Set(titles)];

        try {
          const local = await readLocalPreviews(cwd);

          if (local.errors.length > 0) {
            return sendJson(res, 409, { ok: false, error: local.errors.join(" ") });
          }

          const localTitles = new Set(local.previews.map((preview) => preview.title));
          const unknown = unique.filter((title) => !localTitles.has(title));

          if (unknown.length > 0) {
            return sendJson(res, 400, {
              ok: false,
              error: "Only machine-local directions can be deleted from the registry.",
            });
          }

          const deleted = await dropLocalPreviews(cwd, unique);

          return sendJson(res, 200, { ok: true, deleted });
        } catch {
          return sendJson(res, 500, {
            ok: false,
            error: "The directions could not be deleted from Leglas.",
          });
        }
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/references` && req.method === "POST") {
      const declaredLength = req.headers["content-length"];

      if (isString(declaredLength) && Number(declaredLength) > REFERENCE_MAX_BYTES) {
        return sendJson(res, 413, { ok: false, error: "That image is over 10MB." });
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      let refused = false;
      req.on("data", (chunk: Buffer | string) => {
        if (refused) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;

        if (bytes > REFERENCE_MAX_BYTES) {
          refused = true;
          req.pause();
          res.once("finish", () => req.socket.destroy());
          sendJson(res, 413, { ok: false, error: "That image is over 10MB." });

          return;
        }

        chunks.push(buffer);
      });

      return void req.once("end", async () => {
        if (refused) return;

        if (bytes === 0) {
          return sendJson(res, 400, { ok: false, error: "The upload was empty." });
        }

        const body = Buffer.concat(chunks, bytes);
        const image = sniffImage(body);

        if (image === null) {
          return sendJson(res, 415, {
            ok: false,
            error: "Only PNG, JPEG, WebP and GIF images can be attached.",
          });
        }

        const id = newRequestId();
        const file = `${REFERENCES_DIR}/${id}.${image.kind}`;

        try {
          await mkdir(join(cwd, REFERENCES_DIR), { recursive: true });
          await writeFile(join(cwd, file), body);
          // Something new arrived, so drop what was pasted an hour ago and
          // never sent.
          void pruneReferences(cwd).catch(() => {});

          return sendJson(res, 200, {
            ok: true,
            reference: {
              id,
              file,
              name: referenceName(req.headers["x-leglas-filename"]),
              width: image.width,
              height: image.height,
              bytes,
            },
          });
        } catch {
          return sendJson(res, 500, {
            ok: false,
            error: "The image could not be attached.",
          });
        }
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/request` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        // Variant unless told otherwise, since overwriting the source destroys
        // the comparison. An unknown value is refused, not defaulted: the two
        // do different work and only one is reversible.
        if (parsed.mode !== undefined && parsed.mode !== "variant" && parsed.mode !== "replace") {
          return sendJson(res, 400, {
            ok: false,
            error: 'mode must be "variant" or "replace".',
          });
        }

        const mode: RequestMode = parsed.mode === "replace" ? "replace" : "variant";

        if (
          parsed.references !== undefined &&
          (!Array.isArray(parsed.references) ||
            !parsed.references.every(
              (reference): reference is string =>
                isString(reference) && /^[A-Za-z0-9_-]{1,32}$/.test(reference),
            ))
        ) {
          return sendJson(res, 400, { ok: false, error: "references must be uploaded image ids." });
        }

        const references = parsed.references ?? [];

        // A missing reference was pruned after an hour. Dropping it silently
        // would send a request the user didn't make.
        if (references.length > 0) {
          const present = new Set(
            (await readdir(join(cwd, REFERENCES_DIR)).catch((): string[] => [])).map((name) =>
              name.slice(0, name.indexOf(".") === -1 ? name.length : name.indexOf(".")),
            ),
          );

          const gone = references.filter((id) => !present.has(id));

          if (gone.length > 0) {
            return sendJson(res, 410, {
              ok: false,
              error:
                gone.length === 1
                  ? "An attached image is gone: it was pasted over an hour ago and never sent. Attach it again."
                  : "Some attached images are gone: they were pasted over an hour ago and never sent. Attach them again.",
            });
          }
        }

        const width =
          isNumber(parsed.width) && Number.isFinite(parsed.width)
            ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(parsed.width)))
            : 1440;

        // Same live lookup as /api/config, so a direction registered after boot
        // resolves.
        const previews = await livePreviews();
        const preview = previews.find((entry) => entry.title === parsed.title);

        if (!preview) {
          return sendJson(res, 400, { ok: false, error: "Unknown preview, or empty request." });
        }

        // Notes carry their own address and words, so pins alone make a
        // request. Nothing at all still doesn't.
        const notes = annotationsFor(await readAnnotations(cwd).catch(() => []), preview.title);

        const intent = requestIntent(parsed.intent);

        if (intent === null) {
          return sendJson(res, 400, { ok: false, error: "A request's words must be text." });
        }

        if (!intent && notes.length === 0) {
          return sendJson(res, 400, { ok: false, error: "Unknown preview, or empty request." });
        }

        // The composer stays open during a run so the next change can queue.
        // The same words at the same direction twice is a copy of waiting work
        // and costs a provider turn; it usually comes from retyping after a
        // stop.
        const live = (await readRequests(cwd).catch(() => [])).filter(
          (entry) => entry.status === "queued" || entry.status === "picked-up",
        );

        // Pins stay after a fork, so pressing send twice sends the same
        // request. The notes are part of its identity: same words, different
        // pins is a different request.
        const sameNotes = (entry: PendingRequest) => {
          const before = [...(entry.notes ?? [])].sort().join(",");

          return (
            before ===
            notes
              .map((note) => note.id)
              .sort()
              .join(",")
          );
        };

        const compare =
          isString(parsed.compare) && parsed.compare !== preview.title
            ? (previews.find((entry) => entry.title === parsed.compare) ?? null)
            : null;

        // The images are part of the ask: "make it like the other one" against
        // a different other one or picture is a different request. Judged from
        // what was asked, not captured, since a capture can fail.
        const sameContext = (entry: PendingRequest) =>
          (entry.compare ?? null) === (compare?.title ?? null) &&
          [...(entry.references ?? [])].sort().join(",") === [...references].sort().join(",");

        if (
          live.some(
            (entry) =>
              entry.title === preview.title &&
              entry.intent === intent &&
              // The same words in the other mode aren't the same request: one
              // forks, one rewrites.
              (entry.mode ?? "replace") === mode &&
              sameNotes(entry) &&
              sameContext(entry),
          )
        ) {
          return sendJson(res, 409, {
            ok: false,
            duplicate: true,
            error: `That exact change to ${preview.title} is already waiting.`,
          });
        }

        const address = server.address();

        const requestPort =
          address !== null && !isString(address) ? address.port : (options.port ?? DEFAULT_PORT);

        const id = newRequestId();

        const captured = await attachRequest(
          cwd,
          id,
          {
            origin: `http://127.0.0.1:${requestPort}`,
            preview,
            width,
            notes,
            compare,
            references,
          },
          { pool: browserPool },
        );

        const composed = composeRequest(preview, intent, mode, notes, leglasCommand, captured);

        try {
          const queued: Parameters<typeof appendRequest>[1] = {
            title: preview.title,
            url: preview.url,
            intent,
            // The ids travel with the request so a change in place can forget
            // the notes it answered. A fork leaves them.
            ...composed,
          };

          if (notes.length > 0) queued.notes = notes.map((entry) => entry.id);

          if (captured.attachments.length > 0) queued.attachments = captured.attachments;

          if (captured.skipped !== null) queued.captureNote = captured.skipped;

          if (compare !== null) queued.compare = compare.title;

          if (references.length > 0) queued.references = references;
          await appendRequest(cwd, queued, id);
          // The runner polls every two seconds, but the queue just grew here;
          // no reason to wait.
          runner?.nudge();

          return sendJson(res, 200, {
            ok: true,
            ...composed,
            attachments: captured.attachments,
          });
        } catch {
          // The prompt is useful even if the queue couldn't be written, so
          // copying still works. Its files stay for the same reason; the next
          // boot prunes unclaimed ones.
          return sendJson(res, 200, {
            ok: true,
            ...composed,
            attachments: captured.attachments,
            queued: false,
          });
        }
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/capture` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Capture must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.title) || parsed.title === "") {
          return sendJson(res, 400, { ok: false, error: "Capture needs a direction title." });
        }

        if (parsed.note !== undefined && !isString(parsed.note)) {
          return sendJson(res, 400, { ok: false, error: "The note id must be a string." });
        }

        const preview = (await livePreviews()).find((entry) => entry.title === parsed.title);

        if (preview === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such direction." });
        }

        const width =
          isNumber(parsed.width) && Number.isFinite(parsed.width)
            ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(parsed.width)))
            : 1440;

        const browser = await browserPool.acquire();

        if (browser === null) {
          return sendJson(res, 503, {
            ok: false,
            error: browserPool.reason() ?? NO_BROWSER,
          });
        }

        const annotations = isString(parsed.note)
          ? (await readAnnotations(cwd).catch(() => [])).filter(
              (entry) => entry.id === parsed.note && entry.title === preview.title,
            )
          : [];

        const address = server.address();

        const capturePort =
          address !== null && !isString(address) ? address.port : (options.port ?? DEFAULT_PORT);

        const controller = new AbortController();
        const timeoutMarker = Symbol("capture timeout");
        let timedOut!: () => void;

        const timeout = new Promise<typeof timeoutMarker>((resolve) => {
          timedOut = () => resolve(timeoutMarker);
        });

        const timer = setTimeout(() => {
          timedOut();
          controller.abort();
        }, captureDeadlineMs);

        timer.unref?.();

        try {
          const captureInput: Parameters<typeof capturePage>[1] & { signal: AbortSignal } = {
            url: previewUrl(`http://127.0.0.1:${capturePort}`, preview),
            width,
            timeoutMs: CAPTURE_LOAD_MS,
            signal: controller.signal,
          };

          if (annotations.length > 0) {
            captureInput.focuses = annotations.map((entry) => {
              const focus: NonNullable<typeof captureInput.focuses>[number] = {
                selector: entry.anchor.selector,
                text: entry.anchor.text,
                tag: entry.anchor.tag,
                rect: entry.anchor.rect,
              };

              if (entry.anchor.region !== undefined) focus.region = entry.anchor.region;

              return focus;
            });
          }

          const work = capturePage(browser, captureInput);

          const result = await Promise.race([work, timeout]);

          if (result === timeoutMarker) {
            return sendJson(res, 504, { ok: false, error: "The page did not load in time." });
          }

          clearTimeout(timer);
          const crop = annotations.length > 0 ? result.crops[0] : null;
          const shot = crop?.shot ?? result.frame;

          const noteSuffix = isString(parsed.note)
            ? `-${parsed.note.replace(/[^A-Za-z0-9_-]+/g, "-")}`
            : "";

          const name = `${captureSlug(preview.title)}-${result.frame.width}${noteSuffix}.png`;
          const relativeFile = `${CAPTURES_DIR}/show/${name}`;
          await mkdir(join(cwd, CAPTURES_DIR, "show"), { recursive: true });
          await writeFile(join(cwd, relativeFile), shot.png);

          return sendJson(res, 200, {
            ok: true,
            file: relativeFile,
            width: shot.width,
            height: shot.height,
            viewport: result.frame.width,
            errors: result.errors,
            hydration: result.hydration,
            cut: result.cut,
          });
        } catch (error) {
          clearTimeout(timer);

          return sendJson(res, 502, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // The composer taking focus is the earliest honest sign a request is
    // coming. Warming here, not at boot, keeps an idle Leglas from holding a
    // vendor process and its MCP servers.
    if (path === `${LEGLAS_PREFIX}/api/agents/warm` && req.method === "POST") {
      return void readAgentChoice(cwd).then(
        (choice) => {
          if (choice.agent !== null) runner?.prepare(choice.agent);
          sendJson(res, 200, { ok: true });
        },
        () => sendJson(res, 200, { ok: true }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/agents` && req.method === "GET") {
      return void Promise.all([
        currentAgents(query.get("refresh") === "1"),
        readAgentChoice(cwd),
      ]).then(([agents, choice]) =>
        sendJson(res, 200, {
          agents,
          choice: choice.agent,
          customRun: choice.run,
          effort: choice.effort,
        }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/agent` && req.method === "POST") {
      // Only the machine's owner decides what runs on it. A LAN teammate can
      // look, queue and rename, but not choose the executor, so this route
      // requires a local socket.
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return sendJson(res, 403, {
          ok: false,
          error: "The agent choice can only be made from the machine running Leglas.",
        });
      }

      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Agent choice must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isKnownAgent(parsed.agent) && parsed.agent !== "custom") {
          return sendJson(res, 400, { ok: false, error: "Body needs a known agent." });
        }

        if (parsed.run !== undefined && !isString(parsed.run)) {
          return sendJson(res, 400, {
            ok: false,
            error: "The custom run command must be a string.",
          });
        }

        const effort =
          parsed.effort === null || isAgentEffort(parsed.effort) ? parsed.effort : undefined;

        if (parsed.effort !== undefined && effort === undefined) {
          return sendJson(res, 400, {
            ok: false,
            error: "Effort must be a supported level or null.",
          });
        }

        if (parsed.agent === "custom") {
          if (effort !== undefined) {
            return sendJson(res, 400, {
              ok: false,
              error: "Custom agents manage effort in their own command.",
            });
          }

          if (!isString(parsed.run)) {
            return sendJson(res, 400, { ok: false, error: "A custom agent needs a run command." });
          }

          const template = parseTemplate(parsed.run);

          if (!template.ok) return sendJson(res, 400, { ok: false, error: template.error });

          return void saveAgentChoice(cwd, { agent: "custom", run: parsed.run }).then(
            () => sendJson(res, 200, { ok: true }),
            () => sendJson(res, 500, { ok: false, error: "Agent choice could not be saved." }),
          );
        }

        if (
          effort !== undefined &&
          effort !== null &&
          !KNOWN_AGENTS[parsed.agent].efforts.some((supported) => supported === effort)
        ) {
          return sendJson(res, 400, {
            ok: false,
            error: `${KNOWN_AGENTS[parsed.agent].name} does not expose an effort override.`,
          });
        }

        const agent = parsed.agent;
        const choice: Parameters<typeof saveAgentChoice>[1] = { agent };

        if (effort !== undefined) choice.effort = effort;

        return void saveAgentChoice(cwd, choice).then(
          () => {
            runner?.prepare(agent);
            sendJson(res, 200, { ok: true });
          },
          () => sendJson(res, 500, { ok: false, error: "Agent choice could not be saved." }),
        );
      });
    }

    // Watch reports it's alive here, with no identity: two watchers on one
    // project is the user's own mistake, and the interface says the same either
    // way.
    if (path === `${LEGLAS_PREFIX}/api/watch` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isBoolean(parsed.watching)) {
          return sendJson(res, 400, { ok: false, error: "Body needs a watching boolean." });
        }

        // A watcher shutting down clears the mark at once, so the hint stops
        // promising an agent.
        lastSeen = parsed.watching ? Date.now() : null;
        sendJson(res, 200, { ok: true });
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/requests` && req.method === "GET") {
      // Read fresh like config: an agent can collect or clear requests with the
      // interface open.
      const snapshot = runner?.snapshot() ?? {
        running: false,
        requestId: null,
        agent: null,
        activity: null,
        startedAt: null,
        stopping: false,
        waiting: null,
        quietSince: null,
        failedIds: [],
      };

      return void readRequests(cwd).then((requests) =>
        sendConditionalJson(req, res, {
          requests: requests.map(({ id, title, intent, mode, status, failure, notes }) => ({
            id,
            title,
            intent,
            // A fork leaves its parent's document alone; the interface keeps
            // the parent's duplicate verdict because of this.
            mode,
            // Which pins this change speaks for, so the interface can show a
            // note already in an agent's prompt as read.
            notes: notes ?? [],
            // The file can't know the run in flight. Otherwise it's the record,
            // across restarts; the in-memory failed set only covers a verdict
            // that couldn't be written.
            status:
              snapshot.running && snapshot.requestId === id
                ? "running"
                : status === "queued" && snapshot.failedIds.includes(id)
                  ? "failed"
                  : status,
            failure: failure ?? null,
          })),
          agent: {
            attached: externallyAttached(),
            running: snapshot.running,
            name: snapshot.running ? snapshot.agent : null,
            activity: snapshot.running ? snapshot.activity : null,
            startedAt: snapshot.running ? snapshot.startedAt : null,
            // A stop asked for but not yet obeyed, so the card stops describing
            // a live run.
            stopping: snapshot.running && snapshot.stopping,
            // Why a run that looks stalled is stalled, while it is stalled.
            waiting: snapshot.running ? snapshot.waiting : null,
            // When a quiet run last said anything. A run on its way out is
            // stopping, not quiet.
            quietSince: snapshot.running && !snapshot.stopping ? snapshot.quietSince : null,
          },
        }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/requests/cancel` && req.method === "POST") {
      // The id says which run the click meant. Without one the active run stops
      // (old callers); with one, a run that ended in between is left alone
      // instead of the stop hitting its successor.
      if (!hasJsonBody(req)) {
        return sendJson(res, 200, { ok: true, cancelled: runner?.cancel() ?? false });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (parsed.id !== undefined && !isString(parsed.id)) {
          return sendJson(res, 400, { ok: false, error: "The request id must be a string." });
        }

        return sendJson(res, 200, { ok: true, cancelled: runner?.cancel(parsed.id) ?? false });
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/requests/retry` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Retry must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.id)) {
          return sendJson(res, 400, { ok: false, error: "Body needs a request id." });
        }

        const request = (await readRequests(cwd)).find((entry) => entry.id === parsed.id);

        if (request === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such request." });
        }

        // Either record will do: the in-memory set for a run this server saw,
        // or the queue's verdict for one inherited from an earlier process.
        // Without the second, a restart left the request stuck.
        if (!isEnded(request, runner?.snapshot().failedIds ?? [])) {
          return sendJson(res, 400, {
            ok: false,
            error: "Only an ended request can be run again.",
          });
        }

        try {
          const retryId = newRequestId();

          const attachments = await rehomeCaptures(
            cwd,
            request.id,
            retryId,
            request.attachments ?? [],
          ).catch(() => []);

          if (!(await removeRequest(cwd, request.id))) {
            return sendJson(res, 404, { ok: false, error: "No such request." });
          }

          const retry: Parameters<typeof appendRequest>[1] = {
            title: request.title,
            url: request.url,
            intent: request.intent,
            target: request.target,
            // The prompt names captures by path, and watch, a custom command
            // and `requests --json` hand the text over as is.
            prompt:
              attachments.length === 0
                ? request.prompt
                : rehomeText(request.prompt, request.id, retryId),
            // The stored prompt already carries the mode's instructions; its
            // notes and visual context travel with the retry.
          };

          if (request.mode !== undefined) retry.mode = request.mode;

          if (request.notes !== undefined) retry.notes = request.notes;

          if (attachments.length > 0) retry.attachments = attachments;

          if (request.captureNote !== undefined) retry.captureNote = request.captureNote;

          if (request.compare !== undefined) retry.compare = request.compare;

          if (request.references !== undefined) retry.references = request.references;
          await appendRequest(cwd, retry, retryId);
          // appendRequest assigns a fresh id, outside the runner's failed set,
          // so no retry exception is needed.
          runner?.nudge();

          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The request could not be retried." });
        }
      });
    }

    // The notes on a preview and the two ways they change. Read every poll like
    // the queue, since a note can be left in one pane while another is open.
    if (path === `${LEGLAS_PREFIX}/api/annotations` && req.method === "GET") {
      return void readAnnotations(cwd).then((annotations) =>
        sendConditionalJson(req, res, { annotations }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/annotations` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "A note must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.title) || parsed.title.trim() === "") {
          return sendJson(res, 400, { ok: false, error: "A note needs a direction." });
        }

        const anchor = anchorFrom(parsed.anchor);

        if (anchor === null) {
          return sendJson(res, 400, { ok: false, error: "A note needs something to point at." });
        }

        try {
          const annotation = await addAnnotation(cwd, {
            anchor,
            note: isString(parsed.note) ? parsed.note.trim() : "",
            title: parsed.title,
          });

          return sendJson(res, 200, { ok: true, annotation });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The note could not be kept." });
        }
      });
    }

    // Rewording without losing the place. Only the words are taken; the anchor
    // isn't the browser's to resend.
    if (path === `${LEGLAS_PREFIX}/api/annotations/update` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "A note must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.id) || parsed.id === "") {
          return sendJson(res, 400, { ok: false, error: "Body needs the note to reword." });
        }

        // Missing words are refused, not read as empty. Elsewhere a bad field
        // is coerced, at worst recording a note roughly; here the worst case is
        // a request that forgot its words wiping the sentence it meant to fix.
        // Sending an empty note on purpose still clears it.
        if (!isString(parsed.note)) {
          return sendJson(res, 400, { ok: false, error: "A reworded note needs its words." });
        }

        try {
          const annotation = await updateAnnotation(cwd, parsed.id, parsed.note);

          if (annotation === null) {
            return sendJson(res, 404, { ok: false, error: "That note has gone." });
          }

          return sendJson(res, 200, { ok: true, annotation });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The note could not be reworded." });
        }
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/annotations/delete` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Delete must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        const ids = Array.isArray(parsed.ids)
          ? parsed.ids.filter((entry): entry is string => isString(entry))
          : [];

        if (ids.length === 0) {
          return sendJson(res, 400, { ok: false, error: "Body needs the notes to forget." });
        }

        try {
          return sendJson(res, 200, { ok: true, deleted: await removeAnnotations(cwd, ids) });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The notes could not be forgotten." });
        }
      });
    }

    // Dismissing an ended request. The runner won't touch it again, so removal
    // only syncs the file, but it's limited to ended ids so a live request
    // can't be swept.
    if (path === `${LEGLAS_PREFIX}/api/requests/dismiss` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Dismiss must be JSON." });
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", async () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isString(parsed.id)) {
          return sendJson(res, 400, { ok: false, error: "Body needs a request id." });
        }

        const target = (await readRequests(cwd)).find((entry) => entry.id === parsed.id);

        if (target === undefined || !isEnded(target, runner?.snapshot().failedIds ?? [])) {
          return sendJson(res, 400, {
            ok: false,
            error: "Only an ended request can be dismissed.",
          });
        }

        try {
          if (!(await removeRequest(cwd, parsed.id))) {
            return sendJson(res, 404, { ok: false, error: "No such request." });
          }

          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The request could not be dismissed." });
        }
      });
    }

    // The rail holds renames; this saves them for the commands, so a renamed
    // direction answers to that name in a terminal. The whole map at once, as
    // the interface holds it.
    if (path === `${LEGLAS_PREFIX}/api/renames` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      return void req.on("end", () => {
        const parsed = jsonBody(body);

        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isJsonRecord(parsed.renames) && !Array.isArray(parsed.renames)) {
          return sendJson(res, 400, { ok: false, error: "Body needs a renames object." });
        }

        const renames = Object.fromEntries(
          Object.entries(parsed.renames).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        );

        // Failing to save a rename isn't worth an error: the rail still shows
        // it, and the CLI still takes config titles.
        void writeRenames(cwd, renames).then(
          () => sendJson(res, 200, { ok: true }),
          () => sendJson(res, 200, { ok: false }),
        );
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/health`) {
      // The directory lets a command in another process tell this server from
      // one serving another project on a port it happened to find.
      return void probe(target).then((reachable) =>
        sendConditionalJson(req, res, { devServer: target, reachable, cwd }),
      );
    }

    if (path.startsWith(`${FILES_PREFIX}/`)) {
      const rest = path.slice(FILES_PREFIX.length + 1);
      const slash = rest.indexOf("/");
      const slug = slash === -1 ? rest : rest.slice(0, slash);
      let relative = slash === -1 ? "" : rest.slice(slash + 1);

      try {
        relative = decodeURIComponent(relative);
      } catch {
        relative = "";
      }

      const dir = fileMounts.get(slug);

      const serveMount = (): void => {
        if (dir !== undefined && relative !== "" && serveFrom(res, dir, relative)) return;
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end("Leglas: no such preview file.");
      };

      if (!context.remote) return serveMount();

      // A mount is the preview's whole directory under a slug from its title,
      // so the share's manifest decides which a viewer may read, and nothing
      // starting with a dot is served: a file preview at the root mounts the
      // project.
      if (relative.split("/").some((segment) => segment.startsWith("."))) {
        return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
      }

      return void (
        shares?.fileSlugAllowed(slug, context.grantId ?? "") ?? Promise.resolve(false)
      ).then((allowed) => {
        if (!allowed) return sendJson(res, 403, { ok: false, error: "Not available to viewers." });
        serveMount();
      });
    }

    if (path.startsWith(`${LEGLAS_PREFIX}/api/`)) {
      return sendJson(res, 404, { error: "No such Leglas API path." });
    }

    if (path === LEGLAS_PREFIX || path.startsWith(`${LEGLAS_PREFIX}/`)) {
      if (shellDir !== null && serveShellFile(res, shellDir, path)) return;

      if (shellDir !== null) {
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end("Leglas: no such path.");

        return;
      }

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(PLACEHOLDER);

      return;
    }

    return proxy.request(req, res, context.publicOrigin);
  };

  let port = 0;

  const server = http.createServer((req, res) =>
    handleRequest(req, res, {
      remote: false,
      publicOrigin: `http://localhost:${port}`,
    }),
  );

  // An upgraded socket detaches from its server, so close() would hang on any
  // open live-reload connection.
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const handleUpgrade = (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: { remote: boolean },
  ): boolean => {
    // Returns whether the socket was taken, so the share manager can count a
    // viewer against the link.
    const liveUpgrade = context.remote
      ? live.upgrade(req, socket, head, { viewer: true })
      : live.upgrade(req, socket, head);

    if (liveUpgrade) return true;
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    // The live hub owns one shell upgrade; other Leglas upgrades are refused,
    // and everything outside the prefix is the app's.
    if (path.startsWith(`${LEGLAS_PREFIX}/`)) {
      socket.destroy();

      return false;
    }

    proxy.upgrade(req, socket, head);

    return false;
  };

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head, { remote: false });
  });

  const shareOptions: Parameters<typeof createShareManager>[0] = {
    live,
    previews: livePreviewDefinitions,
    previewsForConfig,
    viewerConfig: {
      project,
      devServer: target,
      scanPreviews: config?.scanPreviews ?? true,
    },
    request: (req, res, context) =>
      handleRequest(req, res, {
        remote: true,
        publicOrigin: context.publicOrigin,
        grantId: context.grantId,
      }),
    upgrade: (req, socket, head) => handleUpgrade(req, socket, head, { remote: true }),
  };

  if (options.detectTunnels !== undefined) shareOptions.detectTunnels = options.detectTunnels;

  if (options.startTunnel !== undefined) shareOptions.startTunnel = options.startTunnel;
  shares = createShareManager(shareOptions);

  port = await bind(server, options.port ?? DEFAULT_PORT);
  options.updates?.setPort(port);
  const liveFiles = watchLiveFiles(cwd, bootConfigPath, live);
  liveHealth = watchHealth(target, live, healthProbeMs);
  await pruneCaptures(
    cwd,
    (await readRequests(cwd).catch(() => [])).map((request) => request.id),
  ).catch(() => {});
  await writeServerInfo(cwd, {
    port,
    url: `http://localhost:${port}`,
    pid: process.pid,
  }).catch(() => {});

  const runnerOptions: Parameters<typeof startRunner>[0] = {
    cwd,
    externallyAttached,
    onChange: () => live.nudge("requests"),
    leglasCommand,
  };

  if (options.codexAppServer !== undefined) runnerOptions.codexAppServer = options.codexAppServer;

  if (options.claudeAgentSession !== undefined)
    runnerOptions.claudeAgentSession = options.claudeAgentSession;
  runner = startRunner(runnerOptions);

  /**
   * Renders one direction as `show --screenshot` does and reports what the page
   * said. A generation calls a direction ready only when this is clean; with no
   * browser it can't tell and returns null.
   */
  const renderDirection = async (title: string): Promise<{ errors: readonly string[] } | null> => {
    const preview = (await livePreviews()).find((entry) => entry.title === title);

    if (preview === undefined) return null;
    const browser = await browserPool.acquire();

    if (browser === null) return null;
    const address = server.address();

    const renderPort =
      address !== null && !isString(address) ? address.port : (options.port ?? DEFAULT_PORT);

    try {
      const captured = await capturePage(browser, {
        url: previewUrl(`http://127.0.0.1:${renderPort}`, preview),
        width: 1440,
        timeoutMs: CAPTURE_LOAD_MS,
      });

      return { errors: captured.errors };
    } catch (error) {
      return { errors: [error instanceof Error ? error.message : String(error)] };
    }
  };

  const generationDeps: GenerationDeps = {
    cwd,
    render: renderDirection,
    register: (input) =>
      addLocalPreview(
        cwd,
        input,
        (config?.previews ?? []).filter((entry) => entry.local !== true),
      ),
    unregister: async (titles) => {
      await dropLocalPreviews(cwd, titles);
    },
    titles: async () => {
      const local = await readLocalPreviews(cwd).catch(() => null);

      return new Set(
        [...(config?.previews ?? []), ...(local?.previews ?? [])].map((entry) => entry.title),
      );
    },
    onChange: () => live.nudge("generation"),
  };

  if (options.generationSpawn !== undefined) generationDeps.spawn = options.generationSpawn;
  generations = createGenerations(generationDeps);
  options.updates?.onBusy(() => runner?.snapshot().running ?? false);
  options.updates?.onChange(() => live.nudge("update"));

  let closePromise: Promise<void> | null = null;

  return {
    port,
    url: `http://localhost:${port}`,
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        liveFiles.close();
        liveHealth?.close();
        await options.updates?.close();
        // The share closes alongside the rest: a tunnel sitting on SIGTERM for
        // three seconds mustn't hold the browser, runner and branches open.
        await Promise.all([
          shares?.close() ?? Promise.resolve(),
          branches.stop(),
          runner.stop(),
          generations?.close() ?? Promise.resolve(),
          browserPool.close(),
          live.close(),
        ]);
        await new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.closeAllConnections();
          server.close(() => done());
        });
        await removeServerInfo(cwd, { port, pid: process.pid }).catch(() => {});
      })();

      return closePromise;
    },
  };
}
