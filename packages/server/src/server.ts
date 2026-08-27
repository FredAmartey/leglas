import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { extname, join, normalize, relative } from "node:path";

import { parseTemplate } from "./agent-command.js";
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
  removeCaptures,
  sniffImage,
} from "./attachments.js";
import { NO_BROWSER, createBrowserPool, type BrowserPool } from "./browser.js";
import { MAX_WIDTH, MIN_WIDTH, capturePage } from "./capture.js";
import type { ClaudeTurnRunner } from "./claude-agent-session.js";
import type { CodexTurnRunner } from "./codex-app-server.js";
import {
  KNOWN_AGENTS,
  detectAgents,
  isAgentEffort,
  readAgentChoice,
  saveAgentChoice,
  type DetectedAgent,
  type KnownAgentId,
} from "./agents.js";
import type { LeglasConfig } from "./config.js";
import { findConfigFile } from "./find-config.js";
import { dropLocalPreviews, readLocalPreviews } from "./local-previews.js";
import {
  addAnnotation,
  anchorFrom,
  annotationsFor,
  readAnnotations,
  removeAnnotations,
} from "./annotations.js";
import { createProxyHandler } from "./proxy.js";
import { writeRenames } from "./renames.js";
import {
  appendRequest,
  composeRequest,
  isTerminal,
  newRequestId,
  readRequests,
  removeRequest,
  type PendingRequest,
  type RequestMode,
} from "./requests.js";
import { startRunner, type RunningAgent } from "./runner.js";
import { removeServerInfo, writeServerInfo } from "./server-info.js";

/** Everything Leglas owns lives under this prefix; the rest belongs to the app. */
export const LEGLAS_PREFIX = "/leglas";

export const DEFAULT_PORT = 4100;

/** Ports tried before giving up, so a few stale instances do not block startup. */
const PORT_ATTEMPTS = 20;
const REFERENCE_MAX_BYTES = 10_000_000;

/**
 * How long a watch heartbeat counts for. Watch beats every 2s, so this is three
 * beats: one missed beat under load must not make the interface flicker between
 * attached and not, and three seconds of silence is a process that has gone.
 */
const ATTACHED_WINDOW_MS = 6000;

const CONTENT_TYPES: Record<string, string> = {
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
   * Stable identity for this project, used by the interface to key saved
   * layout. Without it, binding a different port would look like a different
   * project and silently lose the user's rail order and renames.
   */
  project?: string;
  /** Project root, where the request queue is written. */
  cwd?: string;
  /**
   * Exact command for the running Leglas CLI. Embedded requests use it for
   * registration so the agent never pays for npx package discovery or lands
   * on a cached version with a different command surface.
   */
  leglasCommand?: string;
  /**
   * Directories served under FILES_PREFIX, keyed by mount slug. This is how a
   * file-backed preview renders with no dev server at all: the whole
   * directory is mounted, so a page's sibling assets resolve too.
   */
  fileMounts?: ReadonlyMap<string, string>;
  /**
   * Agent detection, injectable so tests need not spawn real vendor CLIs:
   * the default probes each installed CLI's login status.
   */
  detect?: () => Promise<DetectedAgent[]>;
  /** Persistent Codex transport; null disables it (notably in unit tests). */
  codexAppServer?: CodexTurnRunner | null;
  /** Persistent Claude transport; null disables it (notably in unit tests). */
  claudeAgentSession?: ClaudeTurnRunner | null;
  /** Warm screenshot browser, injectable so HTTP tests never launch a desktop browser. */
  pool?: BrowserPool;
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

/** How long one `show --screenshot` may take, and how much of that the load may use. */
const CAPTURE_DEADLINE_MS = 15_000;
const CAPTURE_LOAD_MS = Math.floor(CAPTURE_DEADLINE_MS * LOAD_SHARE);

function captureSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "direction";
}

function referenceName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
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

function isKnownAgent(value: unknown): value is KnownAgentId {
  return typeof value === "string" && Object.hasOwn(KNOWN_AGENTS, value);
}

/**
 * Mutations happen from the machine itself, full stop.
 *
 * The API now decides what runs on this computer, so who may write to it is
 * decided by the one signal a network peer cannot forge: the socket. Every
 * POST requires a loopback peer. Headers prove nothing about a raw client;
 * Origin in particular is only enforced by browsers, so a curl across the
 * LAN can claim any Origin it likes. The Origin check below is therefore
 * not authentication: it defends the local browser against cross-site and
 * DNS-rebinding pages, which is the one job Origin can actually do. When it
 * is present it must match the Host, and the Host must be one this server
 * would plausibly be reached by from its own machine. Teammates on the LAN
 * keep what the share story promises, opening and viewing live directions;
 * changing what runs stays with the person at the keyboard.
 */
function isAllowedMutationHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
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
  if (typeof req.headers.host !== "string") return false;

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
 * Whether a request is over, by either record that can say so.
 *
 * The runner remembers what it ran; the queue file remembers what happened,
 * including across a restart. A request that ended before this process
 * started has only the file to speak for it, and it still deserves a rerun
 * button and a way to be let go.
 */
function isEnded(request: PendingRequest, failedIds: readonly string[]): boolean {
  return isTerminal(request.status) || failedIds.includes(request.id);
}

function hasJsonBody(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return (
    typeof contentType === "string" &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

/**
 * Is the dev server accepting connections? A TCP probe rather than an HTTP
 * request, because a framework mid-compile may accept the socket long before
 * it answers, and "starting up" should read as reachable.
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

  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(candidate).pipe(res);
  return true;
}

function serveShellFile(res: http.ServerResponse, shellDir: string, urlPath: string): boolean {
  // normalize() collapses ".." before it can escape the shell directory.
  const relative = normalize(urlPath.slice(LEGLAS_PREFIX.length)).replace(/^(\.\.[/\\])+/, "");
  // normalize("") is ".", and a bare "/leglas" or "/leglas/" both mean the root
  // document, so all three resolve to index.html.
  const isRoot = relative === "" || relative === "." || relative === "/";
  return serveFrom(res, shellDir, isRoot ? "index.html" : relative);
}

type ConfigSnapshot = { path: string; mtimeMs: number } | null;

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
  if (boot !== null && current !== null && (boot.path !== current.path || boot.mtimeMs !== current.mtimeMs)) {
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
  } = options;
  const browserPool = options.pool ?? createBrowserPool();
  const target = config?.devServer ?? "http://localhost:3000";
  const proxy = createProxyHandler({ target });
  // Boot config is deliberately frozen; this snapshot lets the live endpoint honestly explain when it is stale.
  const bootConfigSnapshot = snapshotConfig(cwd);

  /**
   * When watch last said it was listening. In memory and nowhere else: an
   * attached agent is a running process or it is nothing, and a file would
   * outlive the process that wrote it and promise the user an agent that is no
   * longer there.
   */
  let lastSeen: number | null = null;
  const externallyAttached = () =>
    lastSeen !== null && Date.now() - lastSeen < ATTACHED_WINDOW_MS;
  let runner: RunningAgent | null = null;

  /**
   * Agent detection asks every vendor CLI for its login status, which costs
   * about a second, so ordinary reads use a short cache. The picker can ask
   * for a fresh answer when it opens; that request waits for the real probe so
   * a newly installed or newly signed-in CLI appears on this look, not the
   * next one.
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

    // Authentication state can change while the interface is open, but a
    // routine read does not need to sit behind every vendor CLI while that is
    // checked. Serve the last truthful answer and replace it in the
    // background; opening the picker still uses refresh=1 and awaits the
    // definitive result.
    if (Date.now() - agentsCache.at > AGENTS_FRESH_MS) {
      void probeAgents().catch(() => {
        // A failed refresh leaves the last successful answer intact.
      });
    }
    return Promise.resolve(agentsCache.agents);
  };

  /**
   * Resolve against the same live registry the rail polls, by the same rule.
   *
   * A direction added after boot joins only when it is a plain URL. A branch
   * needs its checkout and a file needs its mount, both built at boot, so a
   * fresh one has no address this server can render: capturing it would
   * load the main app at its route, or nothing at all, and call the result
   * the direction. The rail already holds those back until the restart the
   * CLI asks for, and so does this.
   */
  const livePreviews = async () => {
    const localRead = await readLocalPreviews(cwd).catch(() => null);
    const local = localRead?.errors.length === 0 ? localRead.previews : [];
    const localTitles = new Set(local.map((entry) => entry.title));
    const bootConfig = config?.previews ?? [];
    const boot =
      localRead === null || localRead.errors.length > 0
        ? bootConfig
        : bootConfig.filter(
            (entry) => entry.local !== true || localTitles.has(entry.title),
          );
    const known = new Set(boot.map((entry) => entry.title));
    const fresh = local.filter(
      (entry) =>
        !known.has(entry.title) && entry.branch === undefined && entry.file === undefined,
    );
    return [...boot, ...fresh];
  };

  // Start the only blocking discovery before the browser asks for it. This
  // overlaps CLI authentication with shell and preview loading; the first API
  // read joins the same in-flight promise if it arrives before completion.
  void probeAgents().catch(() => {
    // The endpoint can retry on demand; startup itself must stay available.
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");

    if (
      req.method === "POST" &&
      path.startsWith(`${LEGLAS_PREFIX}/api/`) &&
      !isTrustedMutation(req)
    ) {
      return sendJson(res, 403, { ok: false, error: "Cross-origin API mutations are refused." });
    }

    if (path === `${LEGLAS_PREFIX}/api/config`) {
      // Local previews are re-read on every request, so a direction an agent
      // registers while the interface is open appears without a restart. Only
      // plain url previews can join live: a branch needs its checkout and a
      // file needs its mount, both of which are built at boot, so those wait
      // for the restart the CLI already tells the agent about. A local file
      // that fails to read or validate changes nothing: the boot list stands.
      const boot = config?.previews ?? [];
      const errors = [...configErrors];
      const notice = configStalenessNotice(cwd, bootConfigSnapshot, snapshotConfig(cwd));
      if (notice !== null) errors.push(notice);
      return void readLocalPreviews(cwd)
        .then(({ previews: local, errors: localErrors }) => {
          if (localErrors.length > 0) {
            return sendJson(res, 200, {
              project,
              devServer: target,
              scanPreviews: config?.scanPreviews ?? true,
              previews: boot,
              errors,
              warnings: configWarnings,
            });
          }
          const localTitles = new Set(local.map((preview) => preview.title));
          // Local directions that were present at boot stay fully resolved,
          // including their file mounts and branch servers. Once deleted from
          // the registry they leave this payload immediately instead of
          // lingering until Leglas restarts.
          const currentBoot = boot.filter(
            (preview) => preview.local !== true || localTitles.has(preview.title),
          );
          const known = new Set(currentBoot.map((preview) => preview.title));
          const fresh = local.filter(
            (preview) =>
              !known.has(preview.title) && preview.branch === undefined && preview.file === undefined,
          );
          sendJson(res, 200, {
            project,
            devServer: target,
            scanPreviews: config?.scanPreviews ?? true,
            previews: [...currentBoot, ...fresh],
            errors,
            warnings: configWarnings,
          });
        })
        .catch(() =>
          sendJson(res, 200, {
            project,
            devServer: target,
            scanPreviews: config?.scanPreviews ?? true,
            previews: boot,
            errors,
            warnings: configWarnings,
          }),
        );
    }

    if (path === `${LEGLAS_PREFIX}/api/previews/delete` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", async () => {
        let parsed: { titles?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { titles?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        const titles = parsed.titles;
        if (
          !Array.isArray(titles) ||
          titles.length === 0 ||
          titles.some((title) => typeof title !== "string" || title.trim() === "")
        ) {
          return sendJson(res, 400, {
            ok: false,
            error: "Body needs a non-empty array of direction titles.",
          });
        }

        const unique = [...new Set(titles as string[])];
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
      if (typeof declaredLength === "string" && Number(declaredLength) > REFERENCE_MAX_BYTES) {
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
          // The moment something new arrives is the moment to let go of what
          // was pasted an hour ago and never sent.
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
        let parsed: {
          title?: string;
          intent?: string;
          mode?: unknown;
          width?: unknown;
          compare?: unknown;
          references?: unknown;
        };
        try {
          parsed = JSON.parse(body || "{}") as typeof parsed;
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        // Variant unless the caller says otherwise: a change that overwrites
        // the direction it came from destroys the comparison the tool exists
        // for, so the safe half of the pair is the one a missing field gets.
        // An unrecognised value is refused rather than rounded to a default,
        // because the two do different work and only one of them is reversible.
        if (parsed.mode !== undefined && parsed.mode !== "variant" && parsed.mode !== "replace") {
          return sendJson(res, 400, {
            ok: false,
            error: "mode must be \"variant\" or \"replace\".",
          });
        }
        const mode: RequestMode = parsed.mode === "replace" ? "replace" : "variant";
        if (
          parsed.references !== undefined &&
          (!Array.isArray(parsed.references) ||
            parsed.references.some(
              (reference) =>
                typeof reference !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(reference),
            ))
        ) {
          return sendJson(res, 400, { ok: false, error: "references must be uploaded image ids." });
        }
        const references = (parsed.references ?? []) as string[];
        // A reference that is no longer there was pasted over an hour ago and
        // pruned. Dropping it silently would send the agent a request the
        // user did not make, and clear a thumbnail that never travelled.
        if (references.length > 0) {
          const present = new Set(
            (await readdir(join(cwd, REFERENCES_DIR)).catch(() => [] as string[])).map((name) =>
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
          typeof parsed.width === "number" && Number.isFinite(parsed.width)
            ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(parsed.width)))
            : 1440;
        // Same live lookup as /api/config: a direction registered after boot
        // is on the rail, so a change request against it has to resolve.
        const previews = await livePreviews();
        const preview = previews.find((entry) => entry.title === parsed.title);
        if (!preview) {
          return sendJson(res, 400, { ok: false, error: "Unknown preview, or empty request." });
        }
        // A note carries its own address and its own words, so pins alone are
        // a complete request and the composer is allowed to be empty. Nothing
        // at all still is not a request.
        const notes = annotationsFor(await readAnnotations(cwd).catch(() => []), preview.title);
        if (!parsed.intent?.trim() && notes.length === 0) {
          return sendJson(res, 400, { ok: false, error: "Unknown preview, or empty request." });
        }
        // The composer stays open during a run on purpose: queueing the next
        // change while one is in flight is the point of a queue. Sending the
        // same words at the same direction twice is not: it is a second copy
        // of work already waiting, and it costs a whole provider turn. The
        // usual way in is a stop followed by retyping the same request, which
        // reads as a retry and behaves as a duplicate.
        const intent = (parsed.intent ?? "").trim();
        const live = (await readRequests(cwd).catch(() => [])).filter(
          (entry) => entry.status === "queued" || entry.status === "picked-up",
        );
        // Pins stay on a direction after a fork, so the same send can be made
        // twice by pressing the button twice. That is the same request, and
        // the notes it answers are part of what makes it the same one: the
        // same words at the same direction with a different set of pins is
        // not.
        const sameNotes = (entry: PendingRequest) => {
          const before = [...(entry.notes ?? [])].sort().join(",");
          return before === notes.map((note) => note.id).sort().join(",");
        };
        const compare =
          typeof parsed.compare === "string" && parsed.compare !== preview.title
            ? previews.find((entry) => entry.title === parsed.compare) ?? null
            : null;
        // The images are part of what was asked. "Make it like the other
        // one" against a different other one, or with a different picture
        // attached, is a different request wearing the same words. Judged
        // from what was asked, not from what got captured: a capture can
        // fail and a repeat is still a repeat.
        const sameContext = (entry: PendingRequest) =>
          (entry.compare ?? null) === (compare?.title ?? null) &&
          [...(entry.references ?? [])].sort().join(",") === [...references].sort().join(",");
        if (
          live.some(
            (entry) =>
              entry.title === preview.title &&
              entry.intent === intent &&
              // The same words in the other mode are not the same request:
              // one forks the direction and the other rewrites it. Only a
              // genuine repeat is refused.
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
          typeof address === "object" && address !== null ? address.port : options.port ?? DEFAULT_PORT;
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
        const composed = composeRequest(
          preview,
          intent,
          mode,
          notes,
          leglasCommand,
          captured,
        );
        try {
          await appendRequest(
            cwd,
            {
              title: preview.title,
              url: preview.url,
              intent,
              // The ids travel with the request so a change made in place can
              // forget the notes it answered. A fork leaves them where they are:
              // the direction they point at was not touched.
              ...(notes.length === 0 ? {} : { notes: notes.map((entry) => entry.id) }),
              ...(captured.attachments.length === 0
                ? {}
                : { attachments: captured.attachments }),
              ...(captured.skipped === null ? {} : { captureNote: captured.skipped }),
              ...(compare === null ? {} : { compare: compare.title }),
              ...(references.length === 0 ? {} : { references }),
              ...composed,
            },
            id,
          );
          // The runner polls every two seconds, but the queue just grew in
          // this very process: no reason to make the user watch that gap.
          runner?.nudge();
          return sendJson(res, 200, {
            ok: true,
            ...composed,
            attachments: captured.attachments,
          });
        } catch {
          // The prompt is still useful even if the queue could not be written,
          // so the copy path keeps working when the disk does not. The files
          // it names stay for the same reason; the next boot prunes them once
          // no request claims them.
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
        let parsed: { title?: unknown; width?: unknown; note?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as typeof parsed;
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (typeof parsed.title !== "string" || parsed.title === "") {
          return sendJson(res, 400, { ok: false, error: "Capture needs a direction title." });
        }
        if (parsed.note !== undefined && typeof parsed.note !== "string") {
          return sendJson(res, 400, { ok: false, error: "The note id must be a string." });
        }
        const preview = (await livePreviews()).find((entry) => entry.title === parsed.title);
        if (preview === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such direction." });
        }
        const width =
          typeof parsed.width === "number" && Number.isFinite(parsed.width)
            ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(parsed.width)))
            : 1440;
        const browser = await browserPool.acquire();
        if (browser === null) {
          return sendJson(res, 503, {
            ok: false,
            error: browserPool.reason() ?? NO_BROWSER,
          });
        }
        const annotations =
          typeof parsed.note === "string"
            ? (await readAnnotations(cwd).catch(() => [])).filter(
                (entry) => entry.id === parsed.note && entry.title === preview.title,
              )
            : [];
        const address = server.address();
        const capturePort =
          typeof address === "object" && address !== null ? address.port : options.port ?? DEFAULT_PORT;
        const controller = new AbortController();
        const timeoutMarker = Symbol("capture timeout");
        let timedOut!: () => void;
        const timeout = new Promise<typeof timeoutMarker>((resolve) => {
          timedOut = () => resolve(timeoutMarker);
        });
        const timer = setTimeout(() => {
          timedOut();
          controller.abort();
        }, CAPTURE_DEADLINE_MS);
        timer.unref?.();
        try {
          const work = capturePage(
            browser,
            {
              url: previewUrl(`http://127.0.0.1:${capturePort}`, preview),
              width,
              ...(annotations.length === 0
                ? {}
                : {
                    focuses: annotations.map((entry) => ({
                      selector: entry.anchor.selector,
                      text: entry.anchor.text,
                      tag: entry.anchor.tag,
                      ...(entry.anchor.region === undefined ? {} : { region: entry.anchor.region }),
                      rect: entry.anchor.rect,
                    })),
                  }),
              timeoutMs: CAPTURE_LOAD_MS,
              signal: controller.signal,
            } as Parameters<typeof capturePage>[1] & { signal: AbortSignal },
          );
          const result = await Promise.race([work, timeout]);
          if (result === timeoutMarker) {
            return sendJson(res, 504, { ok: false, error: "The page did not load in time." });
          }
          clearTimeout(timer);
          const crop = annotations.length > 0 ? result.crops[0] : null;
          const shot = crop?.shot ?? result.frame;
          const noteSuffix =
            typeof parsed.note === "string"
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

    // The composer taking focus is the earliest honest sign that a request is
    // coming. Warming here, rather than at boot, is what keeps an idle Leglas
    // from carrying a vendor process (and every MCP server it loads) for a
    // session that never sends one.
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
      // Only the machine's owner decides what executes on it. A teammate on
      // the LAN can look, queue and rename through the interface, but the
      // executor: that choice stays with the person whose computer runs it,
      // so this one route demands the request come from the machine itself.
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
        let parsed: { agent?: unknown; effort?: unknown; run?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as {
            agent?: unknown;
            effort?: unknown;
            run?: unknown;
          };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isKnownAgent(parsed.agent) && parsed.agent !== "custom") {
          return sendJson(res, 400, { ok: false, error: "Body needs a known agent." });
        }
        if (parsed.run !== undefined && typeof parsed.run !== "string") {
          return sendJson(res, 400, { ok: false, error: "The custom run command must be a string." });
        }
        const effort =
          parsed.effort === null || isAgentEffort(parsed.effort) ? parsed.effort : undefined;
        if (parsed.effort !== undefined && effort === undefined) {
          return sendJson(res, 400, { ok: false, error: "Effort must be a supported level or null." });
        }

        if (parsed.agent === "custom") {
          if (effort !== undefined) {
            return sendJson(res, 400, {
              ok: false,
              error: "Custom agents manage effort in their own command.",
            });
          }
          if (typeof parsed.run !== "string") {
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
          !(KNOWN_AGENTS[parsed.agent].efforts as readonly string[]).includes(effort)
        ) {
          return sendJson(res, 400, {
            ok: false,
            error: `${KNOWN_AGENTS[parsed.agent].name} does not expose an effort override.`,
          });
        }

        return void saveAgentChoice(cwd, {
          agent: parsed.agent,
          ...(effort === undefined ? {} : { effort }),
        }).then(
          () => {
            runner?.prepare(parsed.agent as KnownAgentId);
            sendJson(res, 200, { ok: true });
          },
          () => sendJson(res, 500, { ok: false, error: "Agent choice could not be saved." }),
        );
      });
    }

    // Watch says it is alive here, and only here. The heartbeat carries no
    // identity: two watchers on one project is a mistake the user makes in
    // their own terminals, and the interface has one thing to say either way.
    if (path === `${LEGLAS_PREFIX}/api/watch` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", () => {
        let parsed: { watching?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { watching?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (typeof parsed.watching !== "boolean") {
          return sendJson(res, 400, { ok: false, error: "Body needs a watching boolean." });
        }
        // A watcher shutting down clears the mark rather than letting it age
        // out, so the hint stops promising an agent the moment it is gone.
        lastSeen = parsed.watching ? Date.now() : null;
        sendJson(res, 200, { ok: true });
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/requests` && req.method === "GET") {
      // The queue is read fresh just like config: an agent can collect or clear
      // requests while the interface is open, and the next poll tells the truth.
      const snapshot = runner?.snapshot() ?? {
        running: false,
        requestId: null,
        agent: null,
        activity: null,
        startedAt: null,
        stopping: false,
        waiting: null,
        failedIds: [],
      };
      return void readRequests(cwd).then((requests) =>
        sendJson(res, 200, {
          requests: requests.map(({ id, title, intent, mode, status, failure }) => ({
            id,
            title,
            intent,
            // A fork leaves its parent's document alone; the interface keeps
            // the parent's duplicate verdict on the strength of this.
            mode,
            // The run in flight is the one thing the file cannot know. After
            // that the file is the record, including across a restart, and the
            // process-local failed set only covers a request whose verdict
            // could not be written.
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
            // A stop that has been asked for but not yet obeyed. The card
            // says so rather than going on describing a live run.
            stopping: snapshot.running && snapshot.stopping,
            // Why a run that looks stalled is stalled, while it is stalled.
            waiting: snapshot.running ? snapshot.waiting : null,
          },
        }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/requests/cancel` && req.method === "POST") {
      // The id names which run the click meant. Without one the active run is
      // stopped, which keeps old callers working; with one, a run that ended
      // between the click and its arrival is left alone instead of the stop
      // landing on whatever started next.
      if (!hasJsonBody(req)) {
        return sendJson(res, 200, { ok: true, cancelled: runner?.cancel() ?? false });
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", () => {
        let parsed: { id?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { id?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (parsed.id !== undefined && typeof parsed.id !== "string") {
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
        let parsed: { id?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { id?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (typeof parsed.id !== "string") {
          return sendJson(res, 400, { ok: false, error: "Body needs a request id." });
        }

        const request = (await readRequests(cwd)).find((entry) => entry.id === parsed.id);
        if (request === undefined) {
          return sendJson(res, 404, { ok: false, error: "No such request." });
        }
        // Either record will do: the process-local set for a run this server
        // saw, or the queue's own verdict for one it inherited from an earlier
        // process. Without the second, a restart left the request unactionable.
        if (!isEnded(request, runner?.snapshot().failedIds ?? [])) {
          return sendJson(res, 400, { ok: false, error: "Only an ended request can be run again." });
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
          await appendRequest(
            cwd,
            {
              title: request.title,
              url: request.url,
              intent: request.intent,
              target: request.target,
              // The prompt names the captures by path, and the embedded pipes
              // are not its only readers: watch, a custom command and
              // `requests --json` all hand the text over as it stands.
              prompt:
                attachments.length === 0
                  ? request.prompt
                  : rehomeText(request.prompt, request.id, retryId),
              // The stored prompt already carries the mode's instructions;
              // its notes and visual context travel with the retry too.
              ...(request.mode === undefined ? {} : { mode: request.mode }),
              ...(request.notes === undefined ? {} : { notes: request.notes }),
              ...(attachments.length === 0 ? {} : { attachments }),
              ...(request.captureNote === undefined ? {} : { captureNote: request.captureNote }),
              ...(request.compare === undefined ? {} : { compare: request.compare }),
              ...(request.references === undefined ? {} : { references: request.references }),
            },
            retryId,
          );
          // appendRequest assigns a fresh id, which is naturally outside the
          // runner's process-local failed set and needs no retry exception.
          runner?.nudge();
          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The request could not be retried." });
        }
      });
    }

    // Letting go of a failed request. The runner will never touch it again
    // anyway, so removal only makes the queue file agree with that, but it is
    // held to failed ids so a live or waiting request cannot be swept away.
    // The notes left on a preview, and the two ways they change. They are read
    // on every poll like the queue is, because a note can be left in one pane
    // while another is being looked at.
    if (path === `${LEGLAS_PREFIX}/api/annotations` && req.method === "GET") {
      return void readAnnotations(cwd).then((annotations) =>
        sendJson(res, 200, { annotations }),
      );
    }

    if (path === `${LEGLAS_PREFIX}/api/annotations` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "A note must be JSON." });
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", async () => {
        let parsed: { title?: unknown; note?: unknown; anchor?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as typeof parsed;
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (typeof parsed.title !== "string" || parsed.title.trim() === "") {
          return sendJson(res, 400, { ok: false, error: "A note needs a direction." });
        }
        const anchor = anchorFrom(parsed.anchor);
        if (anchor === null) {
          return sendJson(res, 400, { ok: false, error: "A note needs something to point at." });
        }
        try {
          const annotation = await addAnnotation(cwd, {
            anchor,
            note: typeof parsed.note === "string" ? parsed.note.trim() : "",
            title: parsed.title,
          });
          return sendJson(res, 200, { ok: true, annotation });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The note could not be kept." });
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
        let parsed: { ids?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { ids?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        const ids = Array.isArray(parsed.ids)
          ? parsed.ids.filter((entry): entry is string => typeof entry === "string")
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

    if (path === `${LEGLAS_PREFIX}/api/requests/dismiss` && req.method === "POST") {
      if (!hasJsonBody(req)) {
        return sendJson(res, 400, { ok: false, error: "Dismiss must be JSON." });
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", async () => {
        let parsed: { id?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { id?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (typeof parsed.id !== "string") {
          return sendJson(res, 400, { ok: false, error: "Body needs a request id." });
        }
        const target = (await readRequests(cwd)).find((entry) => entry.id === parsed.id);
        if (target === undefined || !isEnded(target, runner?.snapshot().failedIds ?? [])) {
          return sendJson(res, 400, { ok: false, error: "Only an ended request can be dismissed." });
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

    // The rail holds the renames; this puts them where the commands can read
    // them, so a direction the user renamed still answers to that name from a
    // terminal. Whole map at once, because that is how the interface holds it
    // and a partial update would drift from what is on screen.
    if (path === `${LEGLAS_PREFIX}/api/renames` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", () => {
        let parsed: { renames?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { renames?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        if (parsed.renames === null || typeof parsed.renames !== "object") {
          return sendJson(res, 400, { ok: false, error: "Body needs a renames object." });
        }
        const renames = Object.fromEntries(
          Object.entries(parsed.renames as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        );
        // A rename that cannot be persisted is not worth failing over: the rail
        // still shows it, and the CLI keeps working on config titles.
        void writeRenames(cwd, renames).then(
          () => sendJson(res, 200, { ok: true }),
          () => sendJson(res, 200, { ok: false }),
        );
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/health`) {
      // The directory is part of the answer so a command in another process
      // can tell this server from one serving a different project on a port
      // it happened to find.
      return void probe(target).then((reachable) =>
        sendJson(res, 200, { devServer: target, reachable, cwd }),
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
      if (dir !== undefined && relative !== "" && serveFrom(res, dir, relative)) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("Leglas: no such preview file.");
    }

    if (path.startsWith(`${LEGLAS_PREFIX}/api/`)) {
      return sendJson(res, 404, { error: "No such Leglas API path." });
    }

    if (path === LEGLAS_PREFIX || path.startsWith(`${LEGLAS_PREFIX}/`)) {
      if (shellDir !== null && serveShellFile(res, shellDir, path)) return;
      if (shellDir !== null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end("Leglas: no such path.");
      }
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
  await pruneCaptures(
    cwd,
    (await readRequests(cwd).catch(() => [])).map((request) => request.id),
  ).catch(() => {});
  await writeServerInfo(cwd, {
    port,
    url: `http://localhost:${port}`,
    pid: process.pid,
  }).catch(() => {});
  runner = startRunner({
    cwd,
    externallyAttached,
    leglasCommand,
    ...(options.codexAppServer === undefined
      ? {}
      : { codexAppServer: options.codexAppServer }),
    ...(options.claudeAgentSession === undefined
      ? {}
      : { claudeAgentSession: options.claudeAgentSession }),
  });

  let closePromise: Promise<void> | null = null;

  return {
    port,
    url: `http://localhost:${port}`,
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = Promise.all([runner.stop(), browserPool.close()])
        .then(
          () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
        )
        .then(() => removeServerInfo(cwd, { port, pid: process.pid }).catch(() => {}));
      return closePromise;
    },
  };
}
