import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, test, vi } from "vitest";

import {
  START_TIMEOUT_MS,
  findBrowser,
  launchBrowser,
  type Browser,
  type CdpPage,
} from "./browser.js";
import {
  CROP_MIN,
  FRAME_MAX_HEIGHT,
  capturePage,
  cropBox,
  type Focus,
} from "./capture.js";

/**
 * A live test's ceiling, derived rather than chosen.
 *
 * It has to sit above launchBrowser's own deadline, or vitest kills
 * the test before the launch can either succeed or say why, and the
 * log gets a bare timeout instead of the browser's last words. Double
 * leaves the rest of the test more room than it has ever needed, and
 * deriving it means raising the launch deadline for a slower runner
 * never silently re-inverts the pair.
 */
const LIVE_TEST_TIMEOUT_MS = START_TIMEOUT_MS * 2;

describe("cropBox", () => {
  test("pads a swept region and clamps it at the page edge", () => {
    expect(
      cropBox(
        { x: 0, y: 0, width: 400, height: 400 },
        { x: 0, y: 0, width: 0.1, height: 0.1 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 0, y: 0, width: 320, height: 200 });
  });

  test("grows a tiny element around its centre", () => {
    expect(
      cropBox(
        { x: 490, y: 390, width: 20, height: 20 },
        undefined,
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 340, y: 300, width: 320, height: 200 });
  });

  test("an element larger than the page becomes the page", () => {
    expect(
      cropBox(
        { x: -100, y: -100, width: 2000, height: 1600 },
        undefined,
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

class FakePage implements CdpPage {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  locatorCalls = 0;
  /** How tall the fake document is; taller than the frame cap by default. */
  contentHeight = FRAME_MAX_HEIGHT + 40;
  /** Where the first located element sits. */
  found = { x: 500, y: 100, width: 100, height: 40 };
  /** What the main document answered with. */
  documentStatus = 200;
  /** Load errors to emit instead of the default console line. */
  loadErrors: string[] | null = null;

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    if (method === "Page.navigate") {
      queueMicrotask(() => {
        this.emit("Network.responseReceived", {
          type: "Document",
          response: { status: this.documentStatus },
        });
        if (this.loadErrors === null) {
          this.emit("Runtime.consoleAPICalled", {
            type: "error",
            args: [{ value: "boom" }, { description: "details" }],
          });
          this.emit("Log.entryAdded", { entry: { level: "error", text: "favicon.ico failed" } });
        } else {
          for (const text of this.loadErrors) {
            this.emit("Log.entryAdded", { entry: { level: "error", text } });
          }
        }
        this.emit("Page.loadEventFired", {});
      });
      return {} as T;
    }
    if (method === "Page.getLayoutMetrics") {
      return { cssContentSize: { width: 1200.1, height: this.contentHeight } } as T;
    }
    if (method === "Page.captureScreenshot") {
      return { data: Buffer.from("png-data").toString("base64") } as T;
    }
    if (method === "Runtime.evaluate") {
      // Only the locator is counted. The readiness waits evaluate too, and
      // counting those would hand the first note the second answer.
      const expression = String(params.expression);
      if (expression.startsWith("document.fonts") || expression.includes("requestAnimationFrame")) {
        return { result: { value: true } } as T;
      }
      this.locatorCalls += 1;
      return {
        result: {
          value: this.locatorCalls === 1 ? this.found : null,
        },
      } as T;
    }
    return {} as T;
  }

  on(method: string, listener: (params: any) => void): () => void {
    const group = this.listeners.get(method) ?? new Set();
    group.add(listener);
    this.listeners.set(method, group);
    return () => group.delete(listener);
  }

  emit(method: string, params: any): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }
}

describe("capturePage", () => {
  test("takes one frame and ordered crops while collecting load errors", async () => {
    const page = new FakePage();
    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };
    const focuses: Focus[] = [
      {
        selector: "#found",
        text: "Found",
        tag: "p",
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
      {
        selector: "#gone",
        text: "Gone",
        tag: "p",
        rect: { x: 10, y: 20, width: 40, height: 30 },
      },
    ];

    const captured = await capturePage(browser, {
      url: "http://127.0.0.1/page",
      width: 200,
      focuses,
    });

    expect(captured.frame).toMatchObject({ width: 320, height: FRAME_MAX_HEIGHT });
    expect(captured.frame.png.toString()).toBe("png-data");
    expect(captured.cut).toBe(true);
    expect(captured.errors).toEqual(["boom details"]);
    expect(captured.hydration).toBeNull();
    expect(captured.crops).toMatchObject([
      { resolved: "element", shot: { width: CROP_MIN.width * 2, height: CROP_MIN.height * 2 } },
      {
        resolved: "recorded-rect",
        shot: { width: CROP_MIN.width * 2, height: CROP_MIN.height * 2 },
      },
    ]);
    expect(page.sent.filter((entry) => entry.method === "Page.navigate")).toEqual([
      { method: "Page.navigate", params: { url: "http://127.0.0.1/page" } },
    ]);
    const metrics = page.sent.find(
      (entry) => entry.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(metrics?.params).toMatchObject({ width: 320, height: 900, deviceScaleFactor: 1 });
  });

  test("keeps hydration evidence after the console error cap", async () => {
    const page = new FakePage();
    const message = "Uncaught Error: Minified React error #418; visit https://react.dev/errors/418";
    page.loadErrors = [
      ...Array.from(
        { length: 11 },
        (_, index) => `Refused to connect to https://example.com/${index} because it violates the Content Security Policy`,
      ),
      message,
    ];
    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    const captured = await capturePage(browser, {
      url: "http://127.0.0.1/page",
      width: 800,
    });

    expect(captured.errors).toHaveLength(10);
    expect(captured.hydration).toEqual({ framework: "React", message });
  });

  test("a note below the frame cap is cropped where it is, not where the frame ends", async () => {
    const page = new FakePage();
    page.contentHeight = 8000;
    page.found = { x: 500, y: 6000, width: 100, height: 40 };
    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    const captured = await capturePage(browser, {
      url: "http://127.0.0.1/long",
      width: 320,
      focuses: [{ selector: "#deep", text: "Deep", tag: "p", rect: { x: 0, y: 0, width: 0, height: 0 } }],
    });

    // The overview still stops at the cap; the crop does not.
    expect(captured.frame.height).toBe(FRAME_MAX_HEIGHT);
    expect(captured.cut).toBe(true);
    const shots = page.sent.filter((entry) => entry.method === "Page.captureScreenshot");
    expect((shots[1]?.params.clip as { y: number }).y).toBe(6020 - CROP_MIN.height / 2);
  });

  test("a document the app could not serve is not a capture of the direction", async () => {
    const page = new FakePage();
    page.documentStatus = 502;
    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    await expect(capturePage(browser, { url: "http://127.0.0.1/down", width: 800 })).rejects.toThrow(
      "The page did not load: the app answered HTTP 502.",
    );
  });

  test("throws a navigation error and drops an unusable recorded rectangle", async () => {
    const page = new FakePage();
    const original = page.send.bind(page);
    page.send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Page.navigate") return { errorText: "net::ERR_CONNECTION_REFUSED" };
      return original(method, params);
    }) as CdpPage["send"];
    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    await expect(
      capturePage(browser, { url: "http://127.0.0.1:1", width: 800 }),
    ).rejects.toThrow("The page did not load: net::ERR_CONNECTION_REFUSED");
  });
});

const executable = findBrowser();
const liveBrowsers: Browser[] = [];
const liveServers: http.Server[] = [];

afterAll(async () => {
  await Promise.all(liveBrowsers.splice(0).map((browser) => browser.close()));
  await Promise.all(
    liveServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe.skipIf(executable === null)("capturePage with a real browser", () => {
  test.skipIf(process.env.CODEX_SANDBOX === "seatbelt")(
    "renders a local page, crops its element and reads console errors",
    async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Hello there</h1><p id=\"x\">Body copy</p><script>console.error('boom')</script>",
      );
    });
    liveServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const browser = await launchBrowser(executable as string);
    liveBrowsers.push(browser);

    const captured = await capturePage(browser, {
      url: `http://127.0.0.1:${port}/`,
      width: 800,
      focuses: [
        {
          selector: "#x",
          text: "Body copy",
          tag: "p",
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
        {
          selector: "#nope",
          text: "absent",
          tag: "p",
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
    });

    expect([...captured.frame.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngSize(captured.frame.png).width).toBe(800);
    const crop = captured.crops[0];
    expect(crop?.resolved).toBe("element");
    const cropSize = pngSize(crop?.shot.png ?? Buffer.alloc(24));
    expect(cropSize.width).toBeGreaterThanOrEqual(CROP_MIN.width * 2);
    expect(cropSize.height).toBeGreaterThanOrEqual(CROP_MIN.height * 2);
    expect(captured.crops[1]).toBeNull();
    expect(captured.errors.join(" ")).toContain("boom");
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(executable === null)("two captures of one design", () => {
  test.skipIf(process.env.CODEX_SANDBOX === "seatbelt")(
    "agree, even when the page fades itself in after load",
    async () => {
      // An entrance animation is what makes a still design come back
      // different every time. Caught mid-fade the bytes differ, and an agent
      // asked to judge the same direction twice sees two designs.
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<style>
          body { margin: 0; background: #101014; }
          .in { height: 300px; background: #e0864a; opacity: 0; transition: opacity 400ms linear; }
          .in.on { opacity: 1; }
        </style>
        <div class="in" id="panel"></div>
        <script>
          addEventListener("load", () =>
            requestAnimationFrame(() => document.getElementById("panel").classList.add("on")));
        </script>`);
      });
      liveServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const browser = await launchBrowser(executable as string);
      liveBrowsers.push(browser);

      const shots = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        shots.push(await capturePage(browser, { url: `http://127.0.0.1:${port}/`, width: 400 }));
      }

      // Byte-identical, and settled rather than blank: the panel is at full
      // opacity, so the frame is the design at rest.
      expect(shots[1]?.frame.png.equals(shots[0]?.frame.png ?? Buffer.alloc(0))).toBe(true);
      expect(shots[2]?.frame.png.equals(shots[0]?.frame.png ?? Buffer.alloc(0))).toBe(true);
      expect(shots[0]?.frame.png.length).toBeGreaterThan(100);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
