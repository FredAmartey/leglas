import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { extname, join, normalize, relative } from "node:path";

import { parseTemplate } from "./agent-command.js";
import {
  KNOWN_AGENTS,
  detectAgents,
  readAgentChoice,
  saveAgentChoice,
  type DetectedAgent,
  type KnownAgentId,
} from "./agents.js";
import type { LeglasConfig } from "./config.js";
import { findConfigFile } from "./find-config.js";
import { readLocalPreviews } from "./local-previews.js";
import { createProxyHandler } from "./proxy.js";
import { writeRenames } from "./renames.js";
import { appendRequest, composeRequest, readRequests, removeRequest } from "./requests.js";
import { startRunner, type RunningAgent } from "./runner.js";

/** Everything Leglas owns lives under this prefix; the rest belongs to the app. */
export const LEGLAS_PREFIX = "/leglas";

export const DEFAULT_PORT = 4100;

/** Ports tried before giving up, so a few stale instances do not block startup. */
const PORT_ATTEMPTS = 20;

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
    shellDir = null,
    project = "",
    cwd = process.cwd(),
    fileMounts = new Map<string, string>(),
    detect = () => detectAgents(),
  } = options;
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
   * about a second, so only the first request ever waits for it. After that
   * the endpoint answers from here instantly and refreshes behind the
   * response once the answer is old, so signing in shows up on the next look
   * without any request paying the probe.
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
  const currentAgents = (): Promise<DetectedAgent[]> => {
    if (agentsCache === null) return probeAgents();
    if (Date.now() - agentsCache.at > AGENTS_FRESH_MS) {
      void probeAgents().catch(() => {});
    }
    return Promise.resolve(agentsCache.agents);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

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
        .then(({ previews: local }) => {
          const known = new Set(boot.map((preview) => preview.title));
          const fresh = local.filter(
            (preview) =>
              !known.has(preview.title) && preview.branch === undefined && preview.file === undefined,
          );
          sendJson(res, 200, {
            project,
            devServer: target,
            previews: [...boot, ...fresh],
            errors,
          });
        })
        .catch(() =>
          sendJson(res, 200, {
            project,
            devServer: target,
            previews: boot,
            errors,
          }),
        );
    }

    if (path === `${LEGLAS_PREFIX}/api/request` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return void req.on("end", async () => {
        let parsed: { title?: string; intent?: string };
        try {
          parsed = JSON.parse(body || "{}") as { title?: string; intent?: string };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }
        // Same live lookup as /api/config: a direction registered after boot
        // is on the rail, so a change request against it has to resolve.
        const local = await readLocalPreviews(cwd).then(
          (read) => read.previews,
          () => [],
        );
        const preview = [...(config?.previews ?? []), ...local].find(
          (entry) => entry.title === parsed.title,
        );
        if (!preview || !parsed.intent?.trim()) {
          return sendJson(res, 400, { ok: false, error: "Unknown preview, or empty request." });
        }
        const composed = composeRequest(preview, parsed.intent);
        void appendRequest(cwd, {
          title: preview.title,
          url: preview.url,
          intent: parsed.intent.trim(),
          ...composed,
        })
          .then(() => sendJson(res, 200, { ok: true, ...composed }))
          // The prompt is still useful even if the queue could not be written,
          // so the copy path keeps working when the disk does not.
          .catch(() => sendJson(res, 200, { ok: true, ...composed, queued: false }));
      });
    }

    if (path === `${LEGLAS_PREFIX}/api/agents` && req.method === "GET") {
      return void Promise.all([currentAgents(), readAgentChoice(cwd)]).then(([agents, choice]) =>
        sendJson(res, 200, {
          agents,
          choice: choice.agent,
          customRun: choice.run,
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
        let parsed: { agent?: unknown; run?: unknown };
        try {
          parsed = JSON.parse(body || "{}") as { agent?: unknown; run?: unknown };
        } catch {
          return sendJson(res, 400, { ok: false, error: "Body must be JSON." });
        }

        if (!isKnownAgent(parsed.agent) && parsed.agent !== "custom") {
          return sendJson(res, 400, { ok: false, error: "Body needs a known agent." });
        }
        if (parsed.run !== undefined && typeof parsed.run !== "string") {
          return sendJson(res, 400, { ok: false, error: "The custom run command must be a string." });
        }

        if (parsed.agent === "custom") {
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

        return void saveAgentChoice(cwd, { agent: parsed.agent }).then(
          () => sendJson(res, 200, { ok: true }),
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
        failedIds: [],
      };
      return void readRequests(cwd).then((requests) =>
        sendJson(res, 200, {
          requests: requests.map(({ id, title, intent, status }) => ({
            id,
            title,
            intent,
            status:
              snapshot.running && snapshot.requestId === id
                ? "running"
                : snapshot.failedIds.includes(id)
                  ? "failed"
                  : status,
          })),
          agent: {
            attached: externallyAttached(),
            running: snapshot.running,
            name: snapshot.running ? snapshot.agent : null,
            activity: snapshot.running ? snapshot.activity : null,
            startedAt: snapshot.running ? snapshot.startedAt : null,
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
        if (!(runner?.snapshot().failedIds.includes(request.id) ?? false)) {
          return sendJson(res, 400, { ok: false, error: "Only a failed request can be retried." });
        }

        try {
          if (!(await removeRequest(cwd, request.id))) {
            return sendJson(res, 404, { ok: false, error: "No such request." });
          }
          await appendRequest(cwd, {
            title: request.title,
            url: request.url,
            intent: request.intent,
            target: request.target,
            prompt: request.prompt,
          });
          // appendRequest assigns a fresh id, which is naturally outside the
          // runner's process-local failed set and needs no retry exception.
          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 500, { ok: false, error: "The request could not be retried." });
        }
      });
    }

    // Letting go of a failed request. The runner will never touch it again
    // anyway, so removal only makes the queue file agree with that, but it is
    // held to failed ids so a live or waiting request cannot be swept away.
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
        if (!(runner?.snapshot().failedIds.includes(parsed.id) ?? false)) {
          return sendJson(res, 400, { ok: false, error: "Only a failed request can be dismissed." });
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
      return void probe(target).then((reachable) =>
        sendJson(res, 200, { devServer: target, reachable }),
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
  runner = startRunner({ cwd, externallyAttached });

  let closePromise: Promise<void> | null = null;

  return {
    port,
    url: `http://localhost:${port}`,
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = runner.stop().then(
        () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
      return closePromise;
    },
  };
}
