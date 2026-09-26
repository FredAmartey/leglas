import { randomBytes } from "node:crypto";
import nodeProcess from "node:process";
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  isNumber,
  isString,
  isJsonRecord,
  parseJson,
  type JsonValue,
  type JsonRecord,
} from "../json.js";
import type { TimerHandle } from "../timers.js";

/**
 * The browser Leglas borrows for screenshots. Chromium exposes everything
 * needed over CDP, so no browser package ships with Leglas; it finds the copies
 * desktop browsers and dev tools leave on the machine.
 */

export type BrowserSearch = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  onPath?: (name: string) => string | null;
  readdir?: (dir: string) => string[];
};

export const NO_BROWSER =
  "No Chrome, Chromium, Brave or Edge was found on this machine, so Leglas could not take a screenshot. " +
  "On a machine with no browser at all, `npx playwright install chromium` puts one where Leglas will find it. " +
  "Set LEGLAS_BROWSER to point at a specific binary.";

const DARWIN_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Arc.app/Contents/MacOS/Arc",
  "Vivaldi.app/Contents/MacOS/Vivaldi",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "Chromium.app/Contents/MacOS/chrome",
] as const;

const LINUX_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "vivaldi",
  "chrome",
] as const;

const WINDOWS_BROWSERS = [
  "Google/Chrome/Application/chrome.exe",
  "Microsoft/Edge/Application/msedge.exe",
  "BraveSoftware/Brave-Browser/Application/brave.exe",
  "Chromium/Application/chrome.exe",
] as const;

function firstOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);

    try {
      accessSync(candidate, constants.X_OK);

      return candidate;
    } catch {
      // A later PATH entry may contain it.
    }
  }

  return null;
}

/**
 * Where the test tools put a Chrome for Testing, by platform folder. Every
 * entry is tried against each cached build, since a cache holds one platform.
 */
const FOR_TESTING = [
  [
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  [
    "chrome-mac-x64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  ["chrome-win64", "chrome.exe"],
] as const;

/** The smaller shell the same tools install beside it. */
const HEADLESS_SHELL = [
  ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
] as const;

/** A cache directory's build number, so the newest install is tried first. */
function buildNumber(entry: string): number {
  const digits = /(\d+)\s*$/.exec(entry)?.[1];

  return digits === undefined ? 0 : Number(digits);
}

/**
 * Where Playwright and Puppeteer keep their browsers here, builds newest first.
 * Windows keeps them under LOCALAPPDATA, so the caller passes it.
 */
function cacheRoots(
  platform: NodeJS.Platform,
  home: string,
  readdir: (dir: string) => string[] = readableDirectories,
): { root: string; entries: string[] }[] {
  const playwright =
    platform === "darwin"
      ? join(home, "Library", "Caches", "ms-playwright")
      : join(home, ".cache", "ms-playwright");

  const puppeteer = join(home, ".cache", "puppeteer");

  const newestFirst = (dir: string, keep: (entry: string) => boolean = () => true) => ({
    root: dir,
    entries: readdir(dir)
      .filter(keep)
      .sort((left, right) => buildNumber(right) - buildNumber(left)),
  });

  return [
    newestFirst(
      playwright,
      (entry) => entry.startsWith("chromium-") || entry.startsWith("chromium_headless_shell-"),
    ),
    newestFirst(join(puppeteer, "chrome-headless-shell")),
    newestFirst(join(puppeteer, "chrome")),
  ];
}

function readableDirectories(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Find the first supported browser in the documented, stable search order. */
export function findBrowser(search: BrowserSearch = {}): string | null {
  const env = search.env ?? process.env;
  const platform = search.platform ?? process.platform;
  const home = search.home ?? homedir();
  const exists = search.exists ?? existsSync;
  const onPath = search.onPath ?? ((name: string) => firstOnPath(name, env));
  const readdir = search.readdir ?? readableDirectories;

  const firstExisting = (paths: readonly string[]): string | null =>
    paths.find((path) => exists(path)) ?? null;

  for (const candidate of [env.LEGLAS_BROWSER, env.CHROME_PATH, env.PUPPETEER_EXECUTABLE_PATH]) {
    if (isString(candidate) && candidate !== "" && exists(candidate)) return candidate;
  }

  const caches = cacheRoots(platform, home, readdir);

  // A headless shell before a desktop browser. Same Blink and Skia, so the
  // picture is byte-identical once the page stops animating. Measured here: a
  // third of a second to start against two and a half, one process against
  // nine, about 90MB against 900MB.
  const shell = firstExisting(
    caches.flatMap(({ root, entries }) =>
      entries.flatMap((entry) => HEADLESS_SHELL.map((rest) => join(root, entry, ...rest))),
    ),
  );

  if (shell !== null) return shell;

  if (platform === "darwin") {
    const installed = firstExisting(
      ["/Applications", join(home, "Applications")].flatMap((root) =>
        DARWIN_APPS.map((app) => join(root, app)),
      ),
    );

    if (installed !== null) return installed;
  }

  if (platform === "linux") {
    for (const name of LINUX_NAMES) {
      const found = onPath(name);

      if (found !== null) return found;
    }

    const installed = firstExisting([
      ...LINUX_NAMES.flatMap((name) => [join("/usr/bin", name), join("/snap/bin", name)]),
      "/opt/google/chrome/chrome",
    ]);

    if (installed !== null) return installed;
  }

  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (entry): entry is string => isString(entry) && entry !== "",
    );

    const installed = firstExisting(
      roots.flatMap((root) => WINDOWS_BROWSERS.map((browser) => join(root, browser))),
    );

    if (installed !== null) return installed;
  }

  if (platform === "darwin" || platform === "linux") {
    const playwrightRoot =
      platform === "darwin"
        ? join(home, "Library", "Caches", "ms-playwright")
        : join(home, ".cache", "ms-playwright");

    // Playwright ships Chrome for Testing under `chromium-<build>` and a
    // smaller shell under `chromium_headless_shell-<build>`. Both drive CDP,
    // and on a machine with no desktop browser one is often the only Chromium.
    // Newest first.
    const playwright = readdir(playwrightRoot)
      .filter(
        (entry) => entry.startsWith("chromium-") || entry.startsWith("chromium_headless_shell-"),
      )
      .sort((left, right) => buildNumber(right) - buildNumber(left))
      .flatMap((entry) => {
        const root = join(playwrightRoot, entry);

        return [
          ...FOR_TESTING.map((rest) => join(root, ...rest)),
          ...HEADLESS_SHELL.map((rest) => join(root, ...rest)),
          // Older builds shipped a plain Chromium app.
          join(root, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join(root, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join(root, "chrome-linux", "chrome"),
        ];
      });

    const playwrightBrowser = firstExisting(playwright);

    if (playwrightBrowser !== null) return playwrightBrowser;

    // Puppeteer keeps the same two kinds a directory apart.
    const puppeteerCache = join(home, ".cache", "puppeteer");

    for (const kind of ["chrome", "chrome-headless-shell"]) {
      const kindRoot = join(puppeteerCache, kind);

      const found = firstExisting(
        readdir(kindRoot)
          .sort((left, right) => buildNumber(right) - buildNumber(left))
          .flatMap((entry) => {
            const root = join(kindRoot, entry);

            return [...FOR_TESTING, ...HEADLESS_SHELL].map((rest) => join(root, ...rest));
          }),
      );

      if (found !== null) return found;
    }
  }

  return null;
}

export type CdpSocket = {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
};

export type CdpPage = {
  send<T = unknown>(method: string, params?: JsonRecord): Promise<T>;
  /** Subscribe to a CDP event on this page's session. Returns unsubscribe. */
  on(method: string, listener: (params: any) => void): () => void;
};

export type Browser = {
  /** Open a fresh tab, hand it over, close it whatever happens. Serialised: one tab at a time. */
  withPage<T>(work: (page: CdpPage) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly closed: boolean;
};

export type LaunchOptions = {
  spawn?: typeof import("node:child_process").spawn;
  connect?: (url: string) => Promise<CdpSocket>;
  tmpdir?: string;
  startTimeoutMs?: number;
  commandTimeoutMs?: number;
};

/**
 * How long a browser has to expose its endpoint. Ten seconds wasn't enough for
 * the first Chrome start on a cold CI runner. It's the deadline for failure,
 * not a wait: a capture's own shorter deadline abandons it first.
 */
export const START_TIMEOUT_MS = 30_000;

type CommandFrame = {
  id: number;
  method: string;
  params: NonNullable<Parameters<CdpPage["send"]>[1]>;
  sessionId?: string;
};

type PendingCommand = {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type BrowserProcess = ReturnType<typeof nodeSpawn>;

function lines(stream: NodeJS.ReadableStream, listener: (line: string) => void): void {
  let buffered = "";
  stream.on("data", (chunk: string | Buffer) => {
    buffered += chunk.toString();
    const complete = buffered.split("\n");
    buffered = complete.pop() ?? "";

    for (const line of complete) listener(line.replace(/\r$/, ""));
  });
  stream.on("end", () => {
    if (buffered !== "") listener(buffered.replace(/\r$/, ""));
  });
}

async function connectWebSocket(url: string): Promise<CdpSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const opened = () => {
      socket.removeEventListener("error", failed);
      resolve();
    };

    const failed = () => {
      socket.removeEventListener("open", opened);
      reject(new Error("The browser went away."));
    };

    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });

  return {
    send: (text) => socket.send(text),
    onMessage: (listener) =>
      socket.addEventListener("message", (event) => listener(String(event.data))),
    onClose: (listener) => socket.addEventListener("close", listener),
    close: () => socket.close(),
  };
}

/**
 * Waits for the browser to print its debugging endpoint. What it printed on the
 * way is kept and a failure carries the tail, since the browser is the one
 * party that knows why it didn't start.
 */
function endpoint(process: BrowserProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const said: string[] = [];

    const because = () => {
      const tail = said
        .filter((line) => line.trim() !== "")
        .slice(-3)
        .join(" / ");

      return tail === "" ? "" : ` It said: ${tail}`;
    };

    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (isString(value)) resolve(value);
      else reject(value);
    };

    const inspect = (line: string) => {
      if (said.length < 40) said.push(line);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);

      if (match?.[1] !== undefined) finish(match[1]);
    };

    if (process.stdout !== null) lines(process.stdout, inspect);

    if (process.stderr !== null) lines(process.stderr, inspect);
    process.once("error", (error) =>
      finish(new Error(`The browser did not start: ${error.message}.${because()}`)),
    );
    process.once("close", (code) =>
      finish(new Error(`The browser did not start (exit code ${code ?? "unknown"}).${because()}`)),
    );

    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      finish(
        new Error(
          `The browser did not expose its debugging endpoint within ${Math.round(timeoutMs / 1000)}s.${because()}`,
        ),
      );
    }, timeoutMs);

    timer.unref?.();
  });
}

/** Names the Leglas that launched a browser, written inside its own profile. */
const OWNER_FILE = "leglas-owner.json";

/** Every browser profile Leglas makes is named this way, and only Leglas's. */
const PROFILE_PREFIX = "leglas-browser-";

export type ReapDeps = {
  tmpdir?: string;
  now?: () => number;
  list?: (path: string) => Promise<string[]>;
  read?: (path: string) => Promise<string | null>;
  /** Whether a pid still belongs to a running process. */
  alive?: (pid: number) => boolean;
  /** When a profile was made and who owns it, on systems that have owners. */
  profile?: (path: string) => Promise<{ createdAt: number; uid: number | null }>;
  /** This process's user, or null where the platform has no such notion. */
  uid?: () => number | null;
  connect?: (url: string) => Promise<CdpSocket>;
  remove?: (path: string) => Promise<void>;
};

/**
 * How long a profile with no owner record is left alone. The record is written
 * before spawning, so a directory without one is mid-creation or debris from a
 * launch that died; waiting rules out the first, whose removal would pull a
 * live browser's profile away.
 */
const RECORD_GRACE_MS = 60_000;

/** How long an orphan gets to accept its own close before we stop waiting. */
const REAP_CLOSE_MS = 2_000;

function permissionDenied(cause: unknown): cause is { code: "EPERM" } {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
}

function livePid(pid: number): boolean {
  try {
    // Signal 0 checks the process exists without touching it.
    nodeProcess.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return permissionDenied(error);
  }
}

/**
 * Asks one orphaned browser to close over its own endpoint. The URL carries a
 * token that browser minted, so a different browser on a reused port rejects it
 * and anything else can't speak CDP. That's why this isn't a kill by pid: a pid
 * can be reused between proving whose it is and signalling it.
 */
async function closeOrphan(
  url: string,
  connect: (url: string) => Promise<CdpSocket>,
): Promise<boolean> {
  let socket: CdpSocket;

  try {
    socket = await connect(url);
  } catch {
    // Nothing listening, or not CDP: the browser is gone or was never ours.
    return false;
  }

  try {
    socket.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REAP_CLOSE_MS);
      timer.unref?.();
      socket.onClose(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    return true;
  } finally {
    try {
      socket.close();
    } catch {
      // It went on its own, which is the point.
    }
  }
}

/**
 * Closes browsers left by a Leglas that never shut down. The CLI's signal
 * handlers close the pool; a kill, a crash or a lost machine can't be handled,
 * and the headless browser then holds its memory invisibly (114MB per orphan on
 * macOS).
 *
 * Each browser has its own profile directory, where the launching Leglas writes
 * its pid before spawning. A live owner means another Leglas is using it, and
 * it's left alone.
 */
export async function reapOrphanedBrowsers(deps: ReapDeps = {}): Promise<number> {
  const root = deps.tmpdir ?? osTmpdir();
  const clock = deps.now ?? (() => Date.now());

  const list =
    deps.list ??
    (async (path: string) =>
      (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name));

  const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
  const alive = deps.alive ?? livePid;

  const profileOf =
    deps.profile ??
    (async (path: string) => {
      const entry = await stat(path);

      return { createdAt: entry.birthtimeMs, uid: entry.uid };
    });

  const currentUid = deps.uid ?? (() => nodeProcess.getuid?.() ?? null);
  const connect = deps.connect ?? connectWebSocket;

  const remove =
    deps.remove ??
    (async (path: string) => {
      await rm(path, { recursive: true, force: true });
    });

  let names: string[];

  try {
    names = await list(root);
  } catch {
    // An unreadable temp directory isn't worth reporting; the next start tries
    // again.
    return 0;
  }

  let reaped = 0;
  const mine = currentUid();

  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const directory = join(root, name);

    // On Linux the temp directory is shared by every account; another user's
    // profile is skipped before anything opens it.
    const details = await profileOf(directory).catch(() => null);

    if (details === null) continue;

    if (mine !== null && details.uid !== null && details.uid !== mine) continue;

    let record: JsonRecord | null = null;

    try {
      const raw = await read(join(directory, OWNER_FILE));
      const parsed = raw === null ? null : parseJson(raw);
      record = isJsonRecord(parsed) ? parsed : null;
    } catch {
      // Mid-creation or debris; the grace period below tells which.
    }

    const owner = isNumber(record?.owner) ? record.owner : null;

    if (owner !== null && alive(owner)) continue;

    if (owner === null && clock() - details.createdAt < RECORD_GRACE_MS) continue;

    const endpoint = isString(record?.ws) && record.ws !== "" ? record.ws : null;

    if (endpoint !== null && (await closeOrphan(endpoint, connect))) reaped += 1;
    await remove(directory).catch(() => {});
  }

  return reaped;
}

/** Launch Chromium and expose the small, serialized CDP surface captures use. */
export async function launchBrowser(
  executable: string,
  options: LaunchOptions = {},
): Promise<Browser> {
  const spawn = options.spawn ?? nodeSpawn;
  const connect = options.connect ?? connectWebSocket;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;

  const userDataDir = join(
    options.tmpdir ?? osTmpdir(),
    `leglas-browser-${randomBytes(8).toString("hex")}`,
  );

  // Claims the profile before the browser exists. A second Leglas starting now
  // sweeps the temp directory, and a profile with no owner looks like debris.
  // Best effort: an unwritable profile is still a working browser. Written
  // synchronously, since awaiting would let a browser exit before anything
  // listens for it.
  const owned = (fields: { browser?: number | null; ws?: string }): void => {
    try {
      // Owner-only, both of them: the record holds the browser's debugging URL,
      // which lets anyone who reads it drive the browser, and Linux shares the
      // temp directory across accounts.
      mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(userDataDir, OWNER_FILE),
        `${JSON.stringify({ owner: nodeProcess.pid, ...fields })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Nothing here is worth failing a launch.
    }
  };

  owned({});

  const process = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      "--window-size=1440,900",
      // Desktop startup work a screenshot doesn't need. Measured here: about
      // 300MB and half a second off a Chrome launch, most of the wait off a
      // headless shell. `--use-mock-keychain` matters most on macOS, where
      // Chrome otherwise waits on the login keychain.
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-ipc-flooding-protection",
      "--metrics-recording-only",
      "--no-pings",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter," +
        "OptimizationHints,CalculateNativeWinOcclusion,InterestFeedContentSuggestions",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let websocketUrl: string;

  try {
    websocketUrl = await endpoint(process, options.startTimeoutMs ?? START_TIMEOUT_MS);
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // Record the endpoint now that it exists. Its token lets a later Leglas close
  // this browser by asking instead of signalling an unproven pid.
  owned({ browser: process.pid ?? null, ws: websocketUrl });

  let socket: CdpSocket;

  try {
    socket = await connect(websocketUrl);
  } catch (error) {
    process.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let nextId = 1;
  let processClosed = false;
  let socketClosed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, PendingCommand>();
  const listeners = new Map<string, Set<(params: any) => void>>();
  let processEnded!: () => void;

  const ended = new Promise<void>((resolve) => {
    processEnded = resolve;
  });

  const rejectPending = () => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error("The browser went away."));
    }

    pending.clear();
  };

  process.once("close", () => {
    processClosed = true;
    rejectPending();
    processEnded();
  });
  socket.onClose(() => {
    socketClosed = true;
    rejectPending();
  });
  socket.onMessage((text) => {
    let message: JsonRecord;

    try {
      const parsed = parseJson(text);

      if (!isJsonRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }

    if (isNumber(message.id)) {
      const command = pending.get(message.id);

      if (command === undefined) return;
      pending.delete(message.id);
      clearTimeout(command.timer);
      const error = message.error;

      if (error !== undefined) {
        command.reject(
          new Error(
            isJsonRecord(error) && isString(error.message) ? error.message : "CDP command failed.",
          ),
        );
      } else {
        command.resolve(message.result);
      }

      return;
    }

    if (!isString(message.method)) return;
    const sessionId = isString(message.sessionId) ? message.sessionId : "";
    const key = `${sessionId}\0${message.method}`;

    for (const listener of listeners.get(key) ?? []) listener(message.params ?? {});
  });

  const send = <T>(
    method: string,
    params: NonNullable<Parameters<CdpPage["send"]>[1]> = {},
    sessionId?: string,
  ): Promise<T> => {
    if (processClosed || socketClosed) return Promise.reject(new Error("The browser went away."));
    const id = nextId;
    nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A browser silent this long is wedged, not slow. Rejecting only this
        // command left the socket trusted, so every queued capture paid its own
        // full timeout on the same dead browser. Closing the socket makes the
        // next acquire replace it.
        socketClosed = true;
        rejectPending();

        try {
          socket.close();
        } catch {
          // Already gone; the close listener has done this anyway.
        }

        reject(new Error(`The browser did not answer ${method}.`));
      }, commandTimeoutMs);

      timer.unref?.();
      pending.set(id, {
        // SAFETY: The pending command id pairs this CDP result with the method and result type requested by its caller.
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        const message: CommandFrame = { id, method, params };

        if (sessionId !== undefined) message.sessionId = sessionId;
        socket.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("The browser went away."));
      }
    });
  };

  const withPage = <T>(work: (page: CdpPage) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const created = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });

      const targetId = created.targetId;

      try {
        const attached = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });

        const sessionId = attached.sessionId;

        const page: CdpPage = {
          send: <R>(method: string, params: NonNullable<Parameters<CdpPage["send"]>[1]> = {}) =>
            send<R>(method, params, sessionId),
          on: (method, listener) => {
            const key = `${sessionId}\0${method}`;
            const group = listeners.get(key) ?? new Set();
            group.add(listener);
            listeners.set(key, group);

            return () => {
              group.delete(listener);

              if (group.size === 0) listeners.delete(key);
            };
          },
        };

        return await work(page);
      } finally {
        await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    });

    queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  };

  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      if (!processClosed && !socketClosed) await send("Browser.close").catch(() => {});

      if (!processClosed) {
        await Promise.race([
          ended,
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (!processClosed) process.kill("SIGKILL");
              resolve();
            }, 1_000);

            timer.unref?.();
          }),
        ]);
      }

      socket.close();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    })();

    return closing;
  };

  return {
    withPage,
    close,
    // A socket gone with the process alive is the same to a caller: the pool
    // must not hand it out.
    get closed() {
      return processClosed || socketClosed;
    },
  };
}

export type BrowserPool = {
  /** The browser, launched on first use. Null when none can be found or started. */
  acquire(): Promise<Browser | null>;
  /** Why the last acquire returned null, for the one sentence a request carries. */
  reason(): string | null;
  close(): Promise<void>;
};

/** Hold one browser warm across nearby captures, then release it while idle. */
export function createBrowserPool(
  options: {
    find?: () => string | null;
    launch?: typeof launchBrowser;
    idleMs?: number;
    setTimeout?: (cb: () => void, ms: number) => TimerHandle;
    clearTimeout?: (handle: TimerHandle) => void;
  } = {},
): BrowserPool {
  const find = options.find ?? findBrowser;
  const launch = options.launch ?? launchBrowser;
  const idleMs = options.idleMs ?? 60_000;

  const setLater =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();

      return timer;
    });

  const clearLater: NonNullable<typeof options.clearTimeout> =
    options.clearTimeout ?? ((handle) => clearTimeout(handle));

  let browser: Browser | null = null;
  let exposed: Browser | null = null;
  /**
   * Captures in flight, so the idle timer can't close the browser under queued
   * work. Counting only the last completion closed it mid-queue.
   */
  let working = 0;
  let launching: Promise<Browser | null> | null = null;
  let cancelTimer: (() => void) | null = null;
  let lastReason: string | null = null;
  let closed = false;

  const clearIdle = () => {
    if (cancelTimer === null) return;
    cancelTimer();
    cancelTimer = null;
  };

  const scheduleIdle = () => {
    clearIdle();

    if (browser === null || closed || working > 0) return;

    const handle = setLater(() => {
      cancelTimer = null;
      const retiring = browser;
      browser = null;
      exposed = null;
      void retiring?.close().catch(() => {});
    }, idleMs);

    cancelTimer = () => clearLater(handle);
  };

  const wrap = (launched: Browser): Browser => ({
    withPage: async <T>(work: (page: CdpPage) => Promise<T>) => {
      working += 1;
      clearIdle();

      try {
        return await launched.withPage(work);
      } finally {
        working -= 1;

        if (working === 0 && browser === launched) scheduleIdle();
      }
    },
    close: () => launched.close(),
    get closed() {
      return launched.closed;
    },
  });

  const acquire = async (): Promise<Browser | null> => {
    if (closed) return null;
    clearIdle();

    if (browser !== null && !browser.closed) return exposed;

    // Retired, not forgotten, or the process and its profile would outlive
    // every replacement.
    if (browser !== null) {
      const dead = browser;
      browser = null;
      exposed = null;
      void dead.close().catch(() => {});
    }

    if (launching !== null) return launching;

    const executable = find();

    if (executable === null) {
      lastReason = NO_BROWSER;

      return null;
    }

    const attempt = launch(executable)
      .then((launched) => {
        if (closed) {
          void launched.close().catch(() => {});

          return null;
        }

        browser = launched;
        exposed = wrap(launched);
        lastReason = null;
        scheduleIdle();

        return exposed;
      })
      .catch((cause: unknown) => {
        lastReason = cause instanceof Error ? cause.message : String(cause);

        return null;
      })
      .finally(() => {
        if (launching === attempt) launching = null;
      });

    launching = attempt;

    return attempt;
  };

  return {
    acquire,
    reason: () => lastReason,
    close: async () => {
      if (closed) return;
      closed = true;
      clearIdle();
      const active = browser ?? (await launching);
      browser = null;
      exposed = null;
      await active?.close().catch(() => {});
    },
  };
}
