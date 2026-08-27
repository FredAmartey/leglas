import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The browser Leglas borrows for screenshots.
 *
 * Chromium already exposes the whole surface needed here over CDP. Keeping the
 * driver this small avoids making every Leglas install carry a browser package
 * while still finding the copies desktop browsers and developer tooling leave
 * on the machine.
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
  "No Chrome, Chromium, Brave or Edge was found on this machine. Set LEGLAS_BROWSER to a browser binary to let Leglas take screenshots.";

const DARWIN_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Arc.app/Contents/MacOS/Arc",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
] as const;

const LINUX_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
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

  for (const candidate of [env.LEGLAS_BROWSER, env.CHROME_PATH]) {
    if (typeof candidate === "string" && candidate !== "" && exists(candidate)) return candidate;
  }

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
      (entry): entry is string => typeof entry === "string" && entry !== "",
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
    const playwright = readdir(playwrightRoot)
      .filter((entry) => entry.startsWith("chromium-"))
      .sort()
      .reverse()
      .flatMap((entry) => {
        const root = join(playwrightRoot, entry);
        return [
          join(root, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join(root, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join(root, "chrome-linux", "chrome"),
        ];
      });
    const playwrightBrowser = firstExisting(playwright);
    if (playwrightBrowser !== null) return playwrightBrowser;

    const puppeteerRoot = join(home, ".cache", "puppeteer", "chrome");
    const puppeteer = readdir(puppeteerRoot)
      .sort()
      .reverse()
      .flatMap((entry) => {
        const root = join(puppeteerRoot, entry);
        return [
          join(
            root,
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          join(
            root,
            "chrome-mac-x64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          join(root, "chrome-linux64", "chrome"),
        ];
      });
    const puppeteerBrowser = firstExisting(puppeteer);
    if (puppeteerBrowser !== null) return puppeteerBrowser;
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
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
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

type PendingCommand = {
  resolve(value: unknown): void;
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

function endpoint(
  process: BrowserProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof value === "string") resolve(value);
      else reject(value);
    };
    const inspect = (line: string) => {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
      if (match?.[1] !== undefined) finish(match[1]);
    };
    if (process.stdout !== null) lines(process.stdout, inspect);
    if (process.stderr !== null) lines(process.stderr, inspect);
    process.once("error", () => finish(new Error("The browser did not start.")));
    process.once("close", (code) =>
      finish(new Error(`The browser did not start (exit code ${code ?? "unknown"}).`)),
    );
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      finish(new Error("The browser did not start."));
    }, timeoutMs);
    timer.unref?.();
  });
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
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let websocketUrl: string;
  try {
    websocketUrl = await endpoint(process, options.startTimeoutMs ?? 10_000);
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

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
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const command = pending.get(message.id);
      if (command === undefined) return;
      pending.delete(message.id);
      clearTimeout(command.timer);
      const error = message.error as { message?: unknown } | undefined;
      if (error !== undefined) {
        command.reject(
          new Error(typeof error.message === "string" ? error.message : "CDP command failed."),
        );
      } else {
        command.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const key = `${sessionId}\0${message.method}`;
    for (const listener of listeners.get(key) ?? []) listener(message.params ?? {});
  });

  const send = <T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> => {
    if (processClosed || socketClosed) return Promise.reject(new Error("The browser went away."));
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The browser did not answer ${method}.`));
      }, commandTimeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
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
          send: <R>(method: string, params: Record<string, unknown> = {}) =>
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
    // A socket that went with the process still alive is the same thing to
    // a caller: nothing can be sent, so the pool must not hand it out again.
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
export function createBrowserPool(options: {
  find?: () => string | null;
  launch?: typeof launchBrowser;
  idleMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
} = {}): BrowserPool {
  const find = options.find ?? findBrowser;
  const launch = options.launch ?? launchBrowser;
  const idleMs = options.idleMs ?? 60_000;
  const setLater =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number): unknown => {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();
      return timer;
    });
  const clearLater =
    options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let browser: Browser | null = null;
  let exposed: Browser | null = null;
  let launching: Promise<Browser | null> | null = null;
  let timer: unknown = null;
  let lastReason: string | null = null;
  let closed = false;

  const clearIdle = () => {
    if (timer === null) return;
    clearLater(timer);
    timer = null;
  };
  const scheduleIdle = () => {
    clearIdle();
    if (browser === null || closed) return;
    timer = setLater(() => {
      timer = null;
      const retiring = browser;
      browser = null;
      exposed = null;
      void retiring?.close().catch(() => {});
    }, idleMs);
  };
  const wrap = (launched: Browser): Browser => ({
    withPage: async <T>(work: (page: CdpPage) => Promise<T>) => {
      clearIdle();
      try {
        return await launched.withPage(work);
      } finally {
        if (browser === launched) scheduleIdle();
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
    // A browser whose socket went while its process lived is retired here,
    // not merely forgotten: the process and its profile directory would
    // otherwise outlive every replacement.
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
      .catch((error: unknown) => {
        lastReason = error instanceof Error ? error.message : String(error);
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
