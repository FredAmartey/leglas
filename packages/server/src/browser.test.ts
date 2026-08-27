import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  NO_BROWSER,
  createBrowserPool,
  findBrowser,
  launchBrowser,
  type Browser,
  type CdpPage,
  type CdpSocket,
} from "./browser.js";

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

    const puppeteer =
      "/home/u/.cache/puppeteer/chrome/125/chrome-linux64/chrome";
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
  readonly sent: Record<string, unknown>[] = [];
  private messageListeners: Array<(text: string) => void> = [];
  private closeListeners: Array<() => void> = [];
  onSend: (message: Record<string, unknown>) => void = () => {};

  send(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
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

  answer(message: Record<string, unknown>): void {
    for (const listener of this.messageListeners) listener(JSON.stringify(message));
  }

  gone(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function fakeProcess(endpoint = true) {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  if (endpoint) {
    queueMicrotask(() => process.stderr.write("DevTools listening on ws://browser.test/devtools\n"));
  }
  return process;
}

function launchHarness() {
  const process = fakeProcess();
  const socket = new FakeSocket();
  let target = 0;
  socket.onSend = (message) => {
    const id = message.id as number;
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
    const spawn = vi.fn(() => harness.process) as unknown as typeof import("node:child_process").spawn;
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
    const args = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
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
    expect(harness.socket.sent.find((message) => message.method === "Runtime.evaluate")).toMatchObject({
      sessionId: "session-1",
      params: { expression: "1 + 1" },
    });

    await browser.close();
    expect(browser.closed).toBe(true);
  });

  test("serializes tabs and closes each target after work", async () => {
    const harness = launchHarness();
    const browser = await launchBrowser("/browser", {
      spawn: vi.fn(() => harness.process) as unknown as typeof import("node:child_process").spawn,
      connect: async () => harness.socket,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = browser.withPage(async () => held);
    const second = browser.withPage(async () => "second");
    await vi.waitFor(() =>
      expect(harness.socket.sent.filter((message) => message.method === "Target.createTarget")).toHaveLength(1),
    );
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
    expect(harness.socket.sent.filter((message) => message.method === "Target.closeTarget")).toHaveLength(2);
    await browser.close();
  });

  test("rejects pending commands when the socket closes", async () => {
    const harness = launchHarness();
    harness.socket.onSend = (message) => {
      const id = message.id as number;
      if (message.method === "Target.createTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { targetId: "target" } }));
      } else if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => harness.socket.answer({ id, result: { sessionId: "session" } }));
      } else if (message.method === "Runtime.evaluate") {
        queueMicrotask(() => harness.socket.gone());
      }
    };
    const browser = await launchBrowser("/browser", {
      spawn: vi.fn(() => harness.process) as unknown as typeof import("node:child_process").spawn,
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

  test("times out and kills a browser that never exposes CDP", async () => {
    const process = fakeProcess(false);
    await expect(
      launchBrowser("/browser", {
        spawn: vi.fn(() => process) as unknown as typeof import("node:child_process").spawn,
        connect: async () => new FakeSocket(),
        startTimeoutMs: 5,
      }),
    ).rejects.toThrow("did not start");
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("includes the early exit code in a startup failure", async () => {
    const process = fakeProcess(false);
    queueMicrotask(() => process.emit("close", 17, null));
    await expect(
      launchBrowser("/browser", {
        spawn: vi.fn(() => process) as unknown as typeof import("node:child_process").spawn,
        connect: async () => new FakeSocket(),
      }),
    ).rejects.toThrow("exit code 17");
  });
});

function fakeBrowser(): Browser & { pages: number; closes: number } {
  return {
    pages: 0,
    closes: 0,
    closed: false,
    withPage: async function <T>(work: (page: CdpPage) => Promise<T>) {
      this.pages += 1;
      return work({ send: async () => ({}) as never, on: () => () => {} });
    },
    close: async function () {
      this.closes += 1;
      (this as { closed: boolean }).closed = true;
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
    const dead = { closed: false, closes: 0, withPage: async <T,>(work: (page: CdpPage) => Promise<T>) => work({} as CdpPage), close: async () => { dead.closes += 1; } };
    const fresh = fakeBrowser();
    const launch = vi.fn<() => Promise<Browser>>().mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
    const pool = createBrowserPool({ find: () => "/browser", launch, setTimeout: () => "idle", clearTimeout: vi.fn() });

    await pool.acquire();
    dead.closed = true;
    const next = await pool.acquire();

    expect(launch).toHaveBeenCalledTimes(2);
    expect(dead.closes).toBe(1);
    expect(next).not.toBeNull();
    await pool.close();
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
      const browser = await launchBrowser(liveExecutable as string);
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
    20_000,
  );
});
