import { ChildProcess } from "node:child_process";
import { required, unusedPage } from "../test-helpers.js";

import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  NO_BROWSER,
  START_TIMEOUT_MS,
  createBrowserPool,
  findBrowser,
  reapOrphanedBrowsers,
  launchBrowser,
  type Browser,
  type CdpPage,
  type CdpSocket,
} from "./browser.js";

import { type JsonRecord } from "../json.js";

/**
 * Derived from launchBrowser's own deadline and above it, so vitest never kills
 * the test before the launch can succeed or say why.
 */
const LIVE_TEST_TIMEOUT_MS = START_TIMEOUT_MS * 2;

describe("findBrowser", () => {
  test("prefers the explicit Leglas and Chrome paths", () => {
    const exists = vi.fn((path: string) => path === "/chosen/leglas");
    expect(
      findBrowser({
        env: { LEGLAS_BROWSER: "/chosen/leglas", CHROME_PATH: "/chosen/chrome" },
        platform: "linux",
        home: "/home/u",
        exists,
        onPath: () => null,
        readdir: () => [],
      }),
    ).toBe("/chosen/leglas");

    expect(
      findBrowser({
        env: { LEGLAS_BROWSER: "/gone", CHROME_PATH: "/chosen/chrome" },
        platform: "linux",
        home: "/home/u",
        exists: (path) => path === "/chosen/chrome",
        onPath: () => null,
        readdir: () => [],
      }),
    ).toBe("/chosen/chrome");
  });

  test("checks system then user applications on macOS", () => {
    const system = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === system,
        readdir: () => [],
      }),
    ).toBe(system);

    const user = "/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === user,
        readdir: () => [],
      }),
    ).toBe(user);
  });

  test("checks PATH before fixed Linux locations", () => {
    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        exists: () => true,
        onPath: (name) => (name === "chromium" ? "/custom/bin/chromium" : null),
        readdir: () => [],
      }),
    ).toBe("/custom/bin/chromium");

    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        exists: (path) => path === "/snap/bin/brave-browser",
        onPath: () => null,
        readdir: () => [],
      }),
    ).toBe("/snap/bin/brave-browser");
  });

  test("checks each Windows program root", () => {
    const edge = "C:\\Programs/Microsoft/Edge/Application/msedge.exe";
    expect(
      findBrowser({
        env: {
          PROGRAMFILES: "C:\\Programs",
          "PROGRAMFILES(X86)": "C:\\Programs32",
          LOCALAPPDATA: "C:\\Local",
        },
        platform: "win32",
        home: "C:\\Users\\u",
        exists: (path) => path === edge,
      }),
    ).toBe(edge);
  });

  test("uses the newest Playwright and Puppeteer cache entries", () => {
    const playwright =
      "/Users/u/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium";

    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === playwright,
        readdir: (dir) =>
          dir.endsWith("ms-playwright") ? ["firefox-1", "chromium-1100", "chromium-1200"] : [],
      }),
    ).toBe(playwright);

    const puppeteer = "/home/u/.cache/puppeteer/chrome/125/chrome-linux64/chrome";
    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        exists: (path) => path === puppeteer,
        onPath: () => null,
        readdir: (dir) => (dir.endsWith("puppeteer/chrome") ? ["124", "125"] : []),
      }),
    ).toBe(puppeteer);
  });

  test("finds the Chrome for Testing the tools actually install today", () => {
    // The layout Playwright ships now. Looking for Chromium.app found nothing
    // on a current install, so a machine with no desktop browser got no
    // capture.
    const testing =
      "/Users/u/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/" +
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === testing,
        readdir: (dir) => (dir.endsWith("ms-playwright") ? ["chromium-1234"] : []),
      }),
    ).toBe(testing);
  });

  test("finds the headless shell, which is often the only Chromium in a container", () => {
    const shell =
      "/home/u/.cache/ms-playwright/chromium_headless_shell-1234/" +
      "chrome-headless-shell-linux64/chrome-headless-shell";

    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        onPath: () => null,
        exists: (path) => path === shell,
        readdir: (dir) => (dir.endsWith("ms-playwright") ? ["chromium_headless_shell-1234"] : []),
      }),
    ).toBe(shell);

    const puppeteerShell =
      "/home/u/.cache/puppeteer/chrome-headless-shell/130/" +
      "chrome-headless-shell-linux64/chrome-headless-shell";

    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        onPath: () => null,
        exists: (path) => path === puppeteerShell,
        readdir: (dir) => (dir.endsWith("puppeteer/chrome-headless-shell") ? ["130"] : []),
      }),
    ).toBe(puppeteerShell);
  });

  test("prefers the newest build when several are cached", () => {
    const newest = "/home/u/.cache/ms-playwright/chromium-1240/chrome-linux64/chrome";
    expect(
      findBrowser({
        env: {},
        platform: "linux",
        home: "/home/u",
        onPath: () => null,
        // Both builds present: the newer wins, and "1240" must not sort below
        // "999" as strings would.
        exists: (path) =>
          path === newest ||
          path === "/home/u/.cache/ms-playwright/chromium-999/chrome-linux64/chrome",
        readdir: (dir) => (dir.endsWith("ms-playwright") ? ["chromium-999", "chromium-1240"] : []),
      }),
    ).toBe(newest);
  });

  test("honours the executable a test tool already points at", () => {
    expect(
      findBrowser({
        env: { PUPPETEER_EXECUTABLE_PATH: "/opt/chrome/chrome" },
        platform: "linux",
        home: "/home/u",
        onPath: () => null,
        exists: (path) => path === "/opt/chrome/chrome",
        readdir: () => [],
      }),
    ).toBe("/opt/chrome/chrome");
  });

  test("prefers a headless shell over a desktop browser on the same machine", () => {
    const shell =
      "/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/" +
      "chrome-headless-shell-mac-arm64/chrome-headless-shell";

    const desktop = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    // Same engine and picture at a fraction of the weight, so the shell wins
    // when present.
    expect(
      findBrowser({
        env: {},
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === shell || path === desktop,
        readdir: (dir) => (dir.endsWith("ms-playwright") ? ["chromium_headless_shell-1234"] : []),
      }),
    ).toBe(shell);

    // An explicit choice still outranks it.
    expect(
      findBrowser({
        env: { LEGLAS_BROWSER: desktop },
        platform: "darwin",
        home: "/Users/u",
        exists: (path) => path === shell || path === desktop,
        readdir: (dir) => (dir.endsWith("ms-playwright") ? ["chromium_headless_shell-1234"] : []),
      }),
    ).toBe(desktop);
  });

  test("returns null when no supported browser exists", () => {
    expect(
      findBrowser({
        env: {},
        platform: "freebsd",
        home: "/home/u",
        exists: () => false,
        onPath: () => null,
        readdir: () => [],
      }),
    ).toBeNull();
  });
});

class FakeSocket implements CdpSocket {
  readonly sent: JsonRecord[] = [];
  private messageListeners: Array<(text: string) => void> = [];
  private closeListeners: Array<() => void> = [];
  onSend: (message: JsonRecord) => void = () => {};

  send(text: string): void {
    const message: JsonRecord = JSON.parse(text);
    this.sent.push(message);
    this.onSend(message);
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {}

  answer(message: JsonRecord): void {
    for (const listener of this.messageListeners) listener(JSON.stringify(message));
  }

  gone(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function fakeProcess(endpoint = true) {
  const process = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });

  if (endpoint) {
    queueMicrotask(() =>
      process.stderr.write("DevTools listening on ws://browser.test/devtools\n"),
    );
  }

  return process;
}

function launchHarness() {
  const process = fakeProcess();
  const socket = new FakeSocket();
  let target = 0;
  socket.onSend = (message) => {
    const id = required(message.id);

    if (message.method === "Target.createTarget") {
      target += 1;
      queueMicrotask(() => socket.answer({ id, result: { targetId: `target-${target}` } }));
    } else if (message.method === "Target.attachToTarget") {
      queueMicrotask(() => socket.answer({ id, result: { sessionId: `session-${target}` } }));
    } else if (message.method === "Runtime.evaluate") {
      queueMicrotask(() => socket.answer({ id, result: { result: { value: 2 } } }));
    } else if (message.method === "Target.closeTarget") {
      queueMicrotask(() => socket.answer({ id, result: { success: true } }));
    } else if (message.method === "Browser.close") {
      queueMicrotask(() => {
        socket.answer({ id, result: {} });
        process.emit("close", 0, null);
      });
    }
  };

  return { process, socket };
}

describe("launchBrowser", () => {
  test("uses the required argv and frames page commands with their session", async () => {
    const harness = launchHarness();

    const spawn = vi.fn<typeof import("node:child_process").spawn>(() => harness.process);

    const browser = await launchBrowser("/browser", {
      spawn,
      connect: async (url) => {
        expect(url).toBe("ws://browser.test/devtools");

        return harness.socket;
      },
      tmpdir: "/tmp",
    });

    const event = vi.fn();

    const value = await browser.withPage(async (page) => {
      const off = page.on("Runtime.consoleAPICalled", event);
      harness.socket.answer({
        method: "Runtime.consoleAPICalled",
        sessionId: "session-1",
        params: { type: "error" },
      });

      const result = await page.send<{ result: { value: number } }>("Runtime.evaluate", {
        expression: "1 + 1",
      });

      off();

      return result.result.value;
    });

    expect(value).toBe(2);
    expect(event).toHaveBeenCalledWith({ type: "error" });
    expect(spawn).toHaveBeenCalledOnce();
    const args = required(spawn.mock.calls[0]?.[1]);

    if (!Array.isArray(args)) throw new Error("Expected browser arguments.");
    expect(args).toEqual(
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-port=0",
        "--disable-background-networking",
        "--window-size=1440,900",
        "about:blank",
      ]),
    );
    expect(args.some((arg) => arg.startsWith("--user-data-dir=/tmp/leglas-browser-"))).toBe(true);
    expect(
      harness.socket.sent.find((message) => message.method === "Runtime.evaluate"),
    ).toMatchObject({
      sessionId: "session-1",
      params: { expression: "1 + 1" },
    });

    await browser.close();
    expect(browser.closed).toBe(true);
  });

  test("serializes tabs and closes each target after work", async () => {
    const harness = launchHarness();

    const browser = await launchBrowser("/browser", {
      spawn: vi.fn<typeof import("node:child_process").spawn>(() => harness.process),
      connect: async () => harness.socket,
    });

    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = browser.withPage(async () => held);
    const second = browser.withPage(async () => "second");
    await vi.waitFor(() =>
      expect(
        harness.socket.sent.filter((message) => message.method === "Target.createTarget"),
      ).toHaveLength(1),
    );
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
    expect(
      harness.socket.sent.filter((message) => message.method === "Target.closeTarget"),
    ).toHaveLength(2);
    await browser.close();
  });

  test("rejects pending commands when the socket closes", async () => {
    const harness = launchHarness();
    harness.socket.onSend = (message) => {
      const id = required(message.id);

      if (message.method === "Target.createTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { targetId: "target" } }));
      } else if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { sessionId: "session" } }));
      } else if (message.method === "Runtime.evaluate") {
        queueMicrotask(() => harness.socket.gone());
      }
    };

    const browser = await launchBrowser("/browser", {
      spawn: vi.fn<typeof import("node:child_process").spawn>(() => harness.process),
      connect: async () => harness.socket,
    });

    await expect(
      browser.withPage((page) => page.send("Runtime.evaluate", { expression: "wait" })),
    ).rejects.toThrow("browser went away");
    // The process is still there, and the pool must not hand this out again.
    expect(browser.closed).toBe(true);
    harness.process.emit("close", 1, null);
    await browser.close();
  });

  test("a command that never comes back retires the browser rather than the command", async () => {
    // An open but silent socket left the pool trusting the browser, so every
    // queued capture paid its own full timeout.
    const harness = launchHarness();
    harness.socket.onSend = (message) => {
      const id = required(message.id);

      if (message.method === "Target.createTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { targetId: "target" } }));
      } else if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { sessionId: "session" } }));
      }
      // Everything else is swallowed: the socket is alive and silent.
    };

    const browser = await launchBrowser("/browser", {
      spawn: vi.fn<typeof import("node:child_process").spawn>(() => harness.process),
      connect: async () => harness.socket,
      commandTimeoutMs: 10,
    });

    await expect(
      browser.withPage((page) => page.send("Runtime.evaluate", { expression: "wait" })),
    ).rejects.toThrow("did not answer");
    // The browser now reports itself unusable, so the pool retires it.
    expect(browser.closed).toBe(true);
    harness.process.emit("close", 1, null);
    await browser.close();
  });

  test("times out and kills a browser that never exposes CDP", async () => {
    const process = fakeProcess(false);
    await expect(
      launchBrowser("/browser", {
        spawn: vi.fn<typeof import("node:child_process").spawn>(() => process),
        connect: async () => new FakeSocket(),
        startTimeoutMs: 5,
      }),
    ).rejects.toThrow("did not expose its debugging endpoint");
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("a startup failure carries what the browser itself said", async () => {
    // "The browser did not start" alone says nothing on someone else's machine;
    // the browser's own words say why.
    const process = fakeProcess(false);
    queueMicrotask(() => {
      process.stderr.write("Failed to move to new namespace\n");
      process.stderr.write("No usable sandbox!\n");
      process.emit("close", 1, null);
    });
    await expect(
      launchBrowser("/browser", {
        spawn: vi.fn<typeof import("node:child_process").spawn>(() => process),
        connect: async () => new FakeSocket(),
      }),
    ).rejects.toThrow("No usable sandbox");
  });

  test("includes the early exit code in a startup failure", async () => {
    const process = fakeProcess(false);
    queueMicrotask(() => process.emit("close", 17, null));
    await expect(
      launchBrowser("/browser", {
        spawn: vi.fn<typeof import("node:child_process").spawn>(() => process),
        connect: async () => new FakeSocket(),
      }),
    ).rejects.toThrow("exit code 17");
  });
});

function fakeBrowser(): Omit<Browser, "closed"> & {
  closed: boolean;
  pages: number;
  closes: number;
} {
  return {
    pages: 0,
    closes: 0,
    closed: false,
    withPage: async function <T>(work: (page: CdpPage) => Promise<T>) {
      this.pages += 1;

      return work(unusedPage);
    },
    close: async function () {
      this.closes += 1;
      this.closed = true;
    },
  };
}

describe("createBrowserPool", () => {
  test("shares one launch and closes it after the last page goes idle", async () => {
    const browser = fakeBrowser();
    let idle: (() => void) | null = null;
    const launch = vi.fn(async () => browser);

    const pool = createBrowserPool({
      find: () => "/browser",
      launch,
      idleMs: 60,
      setTimeout: (callback, ms) => {
        expect(ms).toBe(60);
        idle = callback;

        return "idle";
      },
      clearTimeout: vi.fn(),
    });

    const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(first).toBe(second);
    expect(launch).toHaveBeenCalledOnce();
    await first?.withPage(async () => "done");
    idle?.();
    await vi.waitFor(() => expect(browser.closes).toBe(1));

    const replacement = fakeBrowser();
    launch.mockResolvedValueOnce(replacement);
    expect(await pool.acquire()).not.toBe(first);
    expect(launch).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  test("retires a browser that lost its socket before launching a replacement", async () => {
    const dead = {
      closed: false,
      closes: 0,
      withPage: async <T>(work: (page: CdpPage) => Promise<T>) => work(unusedPage),
      close: async () => {
        dead.closes += 1;
      },
    };

    const fresh = fakeBrowser();

    const launch = vi
      .fn<() => Promise<Browser>>()
      .mockResolvedValueOnce(dead)
      .mockResolvedValueOnce(fresh);

    const pool = createBrowserPool({
      find: () => "/browser",
      launch,
      setTimeout: () => 0,
      clearTimeout: vi.fn(),
    });

    await pool.acquire();
    dead.closed = true;
    const next = await pool.acquire();

    expect(launch).toHaveBeenCalledTimes(2);
    expect(dead.closes).toBe(1);
    expect(next).not.toBeNull();
    await pool.close();
  });

  test("holds the browser open while other work is still outstanding", async () => {
    // The idle timer was armed by whichever call finished last, so in-flight
    // work lost the browser. Against a real browser, six concurrent captures
    // with a short idle window went one fulfilled and five rejected before
    // this, six fulfilled after.
    let idle: (() => void) | null = null;
    const launched = fakeBrowser();

    const pool = createBrowserPool({
      find: () => "/browser",
      launch: async () => launched,
      idleMs: 1,
      setTimeout: (callback) => {
        idle = callback;

        return "idle";
      },
      clearTimeout: () => {
        idle = null;
      },
    });

    const browser = await pool.acquire();

    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const outstanding = browser?.withPage(async () => {
      await held;

      return "slow";
    });

    await expect(browser?.withPage(async () => "quick")).resolves.toBe("quick");

    // One call has finished and another has not, so nothing may be armed.
    expect(idle).toBeNull();
    expect(launched.closes).toBe(0);

    release();
    await expect(outstanding).resolves.toBe("slow");
    // With the last one done, the timer may arm and the browser may retire.
    expect(idle).not.toBeNull();
    await pool.close();
  });

  test("closing while a launch is still in flight closes what the launch returns", async () => {
    // The pool reads `closed` synchronously before awaiting, so a close
    // mid-launch is honoured by the launch's own continuation, not by close().
    // Subtle enough to pin.
    const launched = fakeBrowser();
    let finishLaunch!: () => void;

    const pending = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });

    const pool = createBrowserPool({
      find: () => "/browser",
      launch: async () => {
        await pending;

        return launched;
      },
    });

    const acquiring = pool.acquire();
    const closing = pool.close();
    finishLaunch();

    await expect(acquiring).resolves.toBeNull();
    await closing;
    // The browser that arrived after the close is not left running.
    await vi.waitFor(() => expect(launched.closes).toBe(1));
    // And the pool stays closed rather than launching another.
    expect(await pool.acquire()).toBeNull();
  });

  test("reports no browser and retries a failed launch on the next acquire", async () => {
    const missing = createBrowserPool({ find: () => null });
    expect(await missing.acquire()).toBeNull();
    expect(missing.reason()).toBe(NO_BROWSER);

    const browser = fakeBrowser();

    const launch = vi
      .fn<() => Promise<Browser>>()
      .mockRejectedValueOnce(new Error("could not launch"))
      .mockResolvedValueOnce(browser);

    const retrying = createBrowserPool({ find: () => "/browser", launch });
    expect(await retrying.acquire()).toBeNull();
    expect(retrying.reason()).toBe("could not launch");
    expect(await retrying.acquire()).not.toBeNull();
    expect(retrying.reason()).toBeNull();
    await retrying.close();
  });
});

const liveExecutable = findBrowser();

describe.skipIf(liveExecutable === null)("launchBrowser with a real browser", () => {
  test.skipIf(process.env.CODEX_SANDBOX === "seatbelt")(
    "evaluates JavaScript over CDP",
    async () => {
      const browser = await launchBrowser(required(liveExecutable));

      try {
        const response = await browser.withPage((page) =>
          page.send<{ result: { value: number } }>("Runtime.evaluate", {
            expression: "1 + 1",
            returnByValue: true,
          }),
        );

        expect(response.result.value).toBe(2);
      } finally {
        await browser.close();
      }
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});

describe("reapOrphanedBrowsers", () => {
  const record = (fields: JsonRecord) => JSON.stringify(fields);
  const now = 1_000_000;
  /** A profile old enough that the grace period for a pending record is over. */
  const old = now - 600_000;

  const reap = (over: Partial<Parameters<typeof reapOrphanedBrowsers>[0]>) =>
    reapOrphanedBrowsers({
      tmpdir: "/tmp",
      now: () => now,
      list: async () => [],
      read: async () => null,
      alive: () => false,
      profile: async () => ({ createdAt: old, uid: 501 }),
      uid: () => 501,
      connect: async () => {
        throw new Error("nothing should connect");
      },
      remove: async () => {},
      ...over,
    });

  const socket = () => {
    const sent: string[] = [];
    let closed = false;

    return {
      sent,
      get closed() {
        return closed;
      },
      handle: {
        send: (message: string) => void sent.push(message),
        onMessage: () => {},
        onClose: () => {},
        close: () => void (closed = true),
      },
    };
  };

  test("closes an orphan through the endpoint only its own browser answers", async () => {
    // A force-quit, crashed or terminal-closed Leglas never runs its shutdown,
    // so its browser is reparented to init and holds its memory for good (114MB
    // over two processes on macOS).
    //
    // Closed over the debugging endpoint, not by pid. The URL carries a token
    // that browser minted, so only it accepts it. A pid can be reused between
    // proving whose it is and signalling it.
    const live = socket();
    const removed: string[] = [];

    const reaped = await reap({
      list: async () => ["leglas-browser-dead", "unrelated"],
      read: async () =>
        record({ owner: 4242, browser: 9001, ws: "ws://127.0.0.1:51000/devtools/browser/tok" }),
      alive: (pid) => pid !== 4242,
      connect: async (url) => {
        expect(url).toBe("ws://127.0.0.1:51000/devtools/browser/tok");

        return live.handle;
      },
      remove: async (path) => void removed.push(path),
    });

    expect(reaped).toBe(1);
    expect(live.sent.join("")).toContain("Browser.close");
    expect(live.closed).toBe(true);
    expect(removed).toEqual(["/tmp/leglas-browser-dead"]);
  });

  test("leaves a browser alone while its Leglas is still running", async () => {
    // Two Leglas instances on one machine is ordinary; reaping by directory
    // name alone would close the other's browser mid-capture.
    const removed: string[] = [];

    const reaped = await reap({
      list: async () => ["leglas-browser-live"],
      read: async () => record({ owner: 777, browser: 9002, ws: "ws://127.0.0.1:51001/x" }),
      alive: () => true,
      remove: async (path) => void removed.push(path),
    });

    expect(reaped).toBe(0);
    expect(removed).toEqual([]);
  });

  test("a dead endpoint costs nothing and still clears the directory", async () => {
    const removed: string[] = [];

    const reaped = await reap({
      list: async () => ["leglas-browser-gone"],
      read: async () => record({ owner: 4242, ws: "ws://127.0.0.1:51002/x" }),
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
      remove: async (path) => void removed.push(path),
    });

    expect(reaped).toBe(0);
    expect(removed).toEqual(["/tmp/leglas-browser-gone"]);
  });

  test("spares a profile whose record has not been written yet", async () => {
    // The owner record is written before spawning, but a directory can be seen
    // between being made and being filled. Treating that as an orphan let one
    // Leglas delete another's profile mid-launch.
    const removed: string[] = [];

    const reaped = await reap({
      list: async () => ["leglas-browser-newborn"],
      read: async () => {
        throw new Error("ENOENT");
      },
      profile: async () => ({ createdAt: now - 1_000, uid: 501 }),
      remove: async (path) => void removed.push(path),
    });

    expect(reaped).toBe(0);
    expect(removed).toEqual([]);
  });

  test("clears a long-abandoned profile that never got a record", async () => {
    const removed: string[] = [];
    await reap({
      list: async () => ["leglas-browser-halfborn"],
      read: async () => {
        throw new Error("ENOENT");
      },
      profile: async () => ({ createdAt: old, uid: 501 }),
      remove: async (path) => void removed.push(path),
    });

    expect(removed).toEqual(["/tmp/leglas-browser-halfborn"]);
  });

  test("never signals a process id, whatever the record says", async () => {
    // No path here reaches a kill, so a recycled pid can't be signalled. A dead
    // endpoint is where a fallback would be tempting, so both cases run.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      await reap({
        list: async () => ["leglas-browser-dead"],
        read: async () => record({ owner: 4242, browser: 9003, ws: "ws://127.0.0.1:51003/x" }),
        connect: async () => socket().handle,
      });

      await reap({
        list: async () => ["leglas-browser-dead"],
        read: async () => record({ owner: 4242, browser: 9003, ws: "ws://127.0.0.1:51003/x" }),
        connect: async () => {
          throw new Error("ECONNREFUSED");
        },
      });

      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  test("leaves another user's profile alone", async () => {
    // On Linux the temp directory is shared by every account. Another user's
    // profile isn't ours to close or read.
    const removed: string[] = [];

    const reaped = await reap({
      list: async () => ["leglas-browser-someone-else"],
      read: async () => {
        throw new Error("nothing should be read from another user's profile");
      },
      profile: async () => ({ createdAt: old, uid: 999 }),
      uid: () => 501,
      remove: async (path) => void removed.push(path),
    });

    expect(reaped).toBe(0);
    expect(removed).toEqual([]);
  });

  test("survives a temp directory it cannot read", async () => {
    await expect(
      reap({
        list: async () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toBe(0);
  });
});
