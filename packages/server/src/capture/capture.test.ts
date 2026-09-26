import { boundPort, required } from "../test-helpers.js";
import { readFile } from "node:fs/promises";
import http from "node:http";

import { afterAll, describe, expect, test, vi } from "vitest";

import {
  START_TIMEOUT_MS,
  findBrowser,
  launchBrowser,
  type Browser,
  type CdpPage,
} from "./browser.js";
import { CROP_MIN, FRAME_MAX_HEIGHT, capturePage, cropBox, type Focus } from "./capture.js";

import { type JsonRecord, isJsonRecord, isString } from "../json.js";

/**
 * Derived from launchBrowser's own deadline and above it, so vitest never kills
 * the test before the launch can succeed or say why.
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
      cropBox({ x: 490, y: 390, width: 20, height: 20 }, undefined, { width: 1000, height: 800 }),
    ).toEqual({ x: 340, y: 300, width: 320, height: 200 });
  });

  test("an element larger than the page becomes the page", () => {
    expect(
      cropBox({ x: -100, y: -100, width: 2000, height: 1600 }, undefined, {
        width: 800,
        height: 600,
      }),
    ).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

class FakePage implements CdpPage {
  readonly sent: Array<{ method: string; params: JsonRecord }> = [];
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  locatorCalls = 0;
  /** How tall the fake document is; taller than the frame cap by default. */
  contentHeight = FRAME_MAX_HEIGHT + 40;
  /** Where the first located element sits. */
  found = { x: 500, y: 100, width: 100, height: 40 };
  /** What the main document answered with. */
  documentStatus = 200;
  /** Load errors to emit instead of the default console line, as text or with the resource they are about. */
  loadErrors: (string | { text: string; url: string })[] | null = null;

  async send<T = unknown>(method: string, params: JsonRecord = {}): Promise<T> {
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
          for (const error of this.loadErrors) {
            this.emit("Log.entryAdded", {
              entry: { level: "error", ...(isString(error) ? { text: error } : error) },
            });
          }
        }

        this.emit("Page.loadEventFired", {});
      });

      // SAFETY: `Page.navigate` acknowledges this fake page without extra response fields.
      return {} as T;
    }

    if (method === "Page.getLayoutMetrics") {
      // SAFETY: This branch implements the layout-metrics response requested by the capture code.
      return { cssContentSize: { width: 1200.1, height: this.contentHeight } } as T;
    }

    if (method === "Page.captureScreenshot") {
      // SAFETY: `Page.captureScreenshot` returns base64 image data; these bytes are the fixture image.
      return { data: Buffer.from("png-data").toString("base64") } as T;
    }

    if (method === "Runtime.evaluate") {
      // Only the locator is counted; counting the readiness evaluations would
      // hand the first note the second answer.
      const expression = String(params.expression);

      if (expression.includes("requestAnimationFrame")) {
        // SAFETY: The readiness expressions evaluate to a boolean remote-object value.
        return { result: { value: true } } as T;
      }

      this.locatorCalls += 1;

      // SAFETY: The locator expression returns this fixture rectangle first, then a null match.
      return {
        result: {
          value: this.locatorCalls === 1 ? this.found : null,
        },
      } as T;
    }

    // SAFETY: The remaining commands only enable domains; their acknowledgements have no payload.
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

  test("a resource that failed to load is named by its path, and a missing favicon is not an error", async () => {
    const page = new FakePage();

    page.loadErrors = [
      {
        text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
        url: "http://localhost:3200/src/heroes/hero-timer.tsx?t=1727229000",
      },
      {
        text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
        url: "http://localhost:3200/favicon.ico",
      },
    ];

    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    const captured = await capturePage(browser, { url: "http://127.0.0.1/page", width: 1440 });

    expect(captured.errors).toEqual([
      "Failed to load resource: the server responded with a status of 500 (Internal Server Error) (/src/heroes/hero-timer.tsx)",
    ]);
  });

  test("keeps hydration evidence after the console error cap", async () => {
    const page = new FakePage();
    const message = "Uncaught Error: Minified React error #418; visit https://react.dev/errors/418";
    page.loadErrors = [
      ...Array.from(
        { length: 11 },
        (_, index) =>
          `Refused to connect to https://example.com/${index} because it violates the Content Security Policy`,
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
      focuses: [
        { selector: "#deep", text: "Deep", tag: "p", rect: { x: 0, y: 0, width: 0, height: 0 } },
      ],
    });

    // The overview still stops at the cap; the crop does not.
    expect(captured.frame.height).toBe(FRAME_MAX_HEIGHT);
    expect(captured.cut).toBe(true);
    const shots = page.sent.filter((entry) => entry.method === "Page.captureScreenshot");
    const clip = shots[1]?.params.clip;

    if (!isJsonRecord(clip)) throw new Error("Expected a screenshot clip.");
    expect(clip.y).toBe(6020 - CROP_MIN.height / 2);
  });

  test("a document the app could not serve is not a capture of the direction", async () => {
    const page = new FakePage();
    page.documentStatus = 502;

    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    await expect(
      capturePage(browser, { url: "http://127.0.0.1/down", width: 800 }),
    ).rejects.toThrow("The page did not load: the app answered HTTP 502.");
  });

  test("throws a navigation error when the page does not load", async () => {
    const page = new FakePage();
    const original = page.send.bind(page);
    page.send = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method === "Page.navigate") {
        // SAFETY: Navigation failures use CDP's `errorText` response field in place of a loaded page.
        return { errorText: "net::ERR_CONNECTION_REFUSED" } as T;
      }

      return original<T>(method, params);
    };

    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    await expect(capturePage(browser, { url: "http://127.0.0.1:1", width: 800 })).rejects.toThrow(
      "The page did not load: net::ERR_CONNECTION_REFUSED",
    );
  });

  test("the shutter waits for what the page asked for after load, arrived or failed", async () => {
    const page = new FakePage();
    const order: string[] = [];
    const original = page.send.bind(page);
    page.send = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method === "Page.captureScreenshot") order.push("shutter");

      const answer = await original<T>(method, params);

      if (method === "Page.navigate") {
        // Asked for after load, as a client-rendered page asks for what it
        // draws with. One arrives, one fails.
        queueMicrotask(() => {
          page.emit("Network.requestWillBeSent", { requestId: "sheet", type: "Stylesheet" });
          page.emit("Network.requestWillBeSent", { requestId: "picture", type: "Image" });
          setTimeout(() => {
            order.push("sheet arrived");
            page.emit("Network.loadingFinished", { requestId: "sheet" });
          }, 40);
          setTimeout(() => {
            order.push("picture failed");
            page.emit("Network.loadingFailed", { requestId: "picture" });
          }, 60);
        });
      }

      return answer;
    };

    const browser: Browser = {
      closed: false,
      close: async () => {},
      withPage: async (work) => work(page),
    };

    await capturePage(browser, { url: "http://127.0.0.1/late", width: 800 });

    expect(order).toEqual(["sheet arrived", "picture failed", "shutter"]);
  });

  test.each([
    {
      name: "waits for a quickly arrived script's reveal",
      script: "after load",
      finishes: 1,
      image: 60,
      shutter: 301,
      looks: 2,
    },
    {
      name: "waits for a failed script's reveal",
      script: "failed after load",
      finishes: 1,
      image: 60,
      shutter: 301,
      looks: 2,
    },
    {
      name: "adds no wait or look without an after-load script",
      script: "absent",
      finishes: 0,
      image: 60,
      shutter: 60,
      looks: 1,
    },
    {
      name: "adds no wait or look for a script requested before load",
      script: "before load",
      finishes: 1,
      image: 60,
      shutter: 60,
      looks: 1,
    },
    {
      name: "waits only the remainder after other assets land",
      script: "after load",
      finishes: 1,
      image: 200,
      shutter: 301,
      looks: 2,
    },
    {
      name: "adds no delay once the reveal window has passed",
      script: "after load",
      finishes: 1,
      image: 400,
      shutter: 400,
      looks: 2,
    },
    {
      name: "ends the reveal wait at the existing deadline",
      script: "after load",
      finishes: 1900,
      image: 60,
      shutter: 2000,
      looks: 1,
    },
  ])("the shutter $name", async ({ script, finishes, image, shutter, looks }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    try {
      const page = new FakePage();
      const began = Date.now();
      let shotAt: number | null = null;
      let scriptLandedAt: number | null = null;
      const original = page.send.bind(page);
      page.send = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
        if (method === "Page.captureScreenshot") shotAt = Date.now() - began;

        if (method === "Page.navigate" && script === "before load") {
          page.emit("Network.requestWillBeSent", { requestId: "code", type: "Script" });
        }

        const answer = await original<T>(method, params);

        if (method === "Page.navigate") {
          queueMicrotask(() => {
            if (script !== "absent") {
              if (script !== "before load") {
                page.emit("Network.requestWillBeSent", { requestId: "code", type: "Script" });
              }

              setTimeout(() => {
                scriptLandedAt = Date.now() - began;
                page.emit(
                  script === "failed after load"
                    ? "Network.loadingFailed"
                    : "Network.loadingFinished",
                  { requestId: "code" },
                );
              }, finishes);
            }

            // The same image takes 60 ms in the original test, so only a script
            // requested after load should slow this capture.
            page.emit("Network.requestWillBeSent", { requestId: "picture", type: "Image" });
            setTimeout(() => page.emit("Network.loadingFinished", { requestId: "picture" }), image);
          });
        }

        return answer;
      };

      const browser: Browser = {
        closed: false,
        close: async () => {},
        withPage: async (work) => work(page),
      };

      const capture = capturePage(browser, { url: "http://127.0.0.1/lazy", width: 800 });
      await vi.runAllTimersAsync();
      await capture;

      expect(shotAt).toBe(shutter);

      if (script.endsWith("after load") && finishes + 300 <= 2000) {
        expect(scriptLandedAt).toBe(finishes);
        expect(shotAt).toBeGreaterThanOrEqual(finishes + 300);
      }

      expect(
        page.sent.filter(
          (entry) =>
            entry.method === "Runtime.evaluate" &&
            String(entry.params.expression).includes("document.fonts"),
        ),
      ).toHaveLength(looks);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a script landing during the reveal wait gets its own window and its content gets a look", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    try {
      const page = new FakePage();
      const began = Date.now();
      const order: string[] = [];
      let shotAt: number | null = null;
      let pictureAsked = false;
      const original = page.send.bind(page);
      page.send = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
        if (method === "Page.captureScreenshot") {
          order.push("shutter");
          shotAt = Date.now() - began;
        }

        if (
          method === "Runtime.evaluate" &&
          String(params.expression).includes("document.fonts") &&
          Date.now() - began >= 552 &&
          !pictureAsked
        ) {
          pictureAsked = true;
          page.emit("Network.requestWillBeSent", { requestId: "picture", type: "Image" });
          setTimeout(() => {
            order.push("picture arrived");
            page.emit("Network.loadingFinished", { requestId: "picture" });
          }, 20);
        }

        const answer = await original<T>(method, params);

        if (method === "Page.navigate") {
          queueMicrotask(() => {
            page.emit("Network.requestWillBeSent", { requestId: "first", type: "Script" });
            setTimeout(() => page.emit("Network.loadingFinished", { requestId: "first" }), 1);
            setTimeout(() => {
              page.emit("Network.requestWillBeSent", { requestId: "second", type: "Script" });
              setTimeout(() => page.emit("Network.loadingFinished", { requestId: "second" }), 1);
            }, 251);
          });
        }

        return answer;
      };

      const browser: Browser = {
        closed: false,
        close: async () => {},
        withPage: async (work) => work(page),
      };

      const capture = capturePage(browser, { url: "http://127.0.0.1/lazy", width: 800 });
      await vi.runAllTimersAsync();
      await capture;

      expect(shotAt).toBe(572);
      expect(order).toEqual(["picture arrived", "shutter"]);
    } finally {
      vi.useRealTimers();
    }
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

function pngSize(png: Buffer) {
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
      const port = boundPort(server);
      const browser = await launchBrowser(required(executable));
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
      // An entrance animation makes a still design come back different each
      // time; caught mid-fade, an agent judging one direction twice sees two
      // designs.
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
      const port = boundPort(server);
      const browser = await launchBrowser(required(executable));
      liveBrowsers.push(browser);

      const shots = [];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        shots.push(await capturePage(browser, { url: `http://127.0.0.1:${port}/`, width: 400 }));
      }

      // Byte-identical and at rest, not blank: the panel is at full opacity.
      expect(shots[1]?.frame.png.equals(shots[0]?.frame.png ?? Buffer.alloc(0))).toBe(true);
      expect(shots[2]?.frame.png.equals(shots[0]?.frame.png ?? Buffer.alloc(0))).toBe(true);
      expect(shots[0]?.frame.png.length).toBeGreaterThan(100);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(executable === null)("a page drawn after load", () => {
  test.skipIf(process.env.CODEX_SANDBOX === "seatbelt")(
    "is shot with the script, stylesheet, web font and image it asked for",
    async () => {
      // A React direction in Vite renders after load, so its code, stylesheets,
      // fonts and images are all requested after it. This page does the same,
      // slowly: its words wait for a stylesheet (as React does for one with a
      // precedence), then ask for their font, and its picture waits for a
      // script, as a lazy component waits for its code.
      const font = await readFile(
        new URL("../../../shell/src/fonts/Satoshi-Regular.woff2", import.meta.url),
      );

      const style = `<style>
        body { margin: 0; padding: 24px; background: #fff; }
        h1 { font: 64px/1.1 Probe, serif; margin: 0; }
        img { display: block; }
      </style>`;

      const words = "<h1>Tonight is decided</h1>";
      const picture = '<img src="/picture.svg" width="200" height="100" alt="">';

      const pages = new Map([
        // Everything in the markup, so load waits for all of it.
        ["/reference", `<link rel="stylesheet" href="/face.css">${style}${words}${picture}`],
        [
          "/late",
          `${style}<script>
            addEventListener("load", () => {
              const sheet = document.createElement("link");
              sheet.rel = "stylesheet";
              sheet.href = "/face.css";
              sheet.onload = () => document.body.insertAdjacentHTML("afterbegin", ${JSON.stringify(words)});
              document.head.append(sheet);
              const code = document.createElement("script");
              code.src = "/draw.js";
              document.head.append(code);
            });
          </script>`,
        ],
        // What an early shot shows: the fallback font and no picture.
        ["/bare", `${style}${words}`],
      ]);

      // The script is the slowest, slower than the stylesheet and font
      // together, so nothing else covers for it.
      const assets = new Map([
        [
          "/face.css",
          {
            type: "text/css",
            body: '@font-face { font-family: Probe; src: url(/font.woff2) format("woff2"); font-display: swap; }',
            ms: 200,
          },
        ],
        ["/font.woff2", { type: "font/woff2", body: font, ms: 200 }],
        [
          "/draw.js",
          {
            type: "text/javascript",
            body: `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(picture)});`,
            ms: 600,
          },
        ],
        [
          "/picture.svg",
          {
            type: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#d9542b"/></svg>',
            ms: 100,
          },
        ],
      ]);

      const server = http.createServer((req, res) => {
        const asset = assets.get(req.url ?? "");

        if (asset !== undefined) {
          setTimeout(() => {
            res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
            res.end(asset.body);
          }, asset.ms);

          return;
        }

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"></head><body>${pages.get(req.url ?? "") ?? ""}</body></html>`,
        );
      });

      liveServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = boundPort(server);
      const browser = await launchBrowser(required(executable));
      liveBrowsers.push(browser);

      const shot = async (path: string) =>
        (await capturePage(browser, { url: `http://127.0.0.1:${port}${path}`, width: 400 })).frame
          .png;

      const reference = await shot("/reference");

      // The font and picture must change the pixels or the comparison proves
      // nothing.
      expect(reference.equals(await shot("/bare"))).toBe(false);
      expect((await shot("/late")).equals(reference)).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.env.CODEX_SANDBOX === "seatbelt")(
    "is shot after a lazy script reveals its content",
    async () => {
      // React can hold a lazy component's content up to 300 ms after its
      // fallback with nothing in flight. This page's late script does the same:
      // a placeholder, then the real words 250 ms later, no request between.
      const style = `<style>
        body { margin: 0; padding: 24px; background: #fff; }
        h1 { font: 64px/1.1 sans-serif; margin: 0; }
      </style>`;

      const words = "<h1>Tonight is decided</h1>";
      const placeholder = "<h1>Loading direction</h1>";

      const pages = new Map([
        ["/reference", `${style}<main id="content">${words}</main>`],
        ["/placeholder", `${style}<main id="content">${placeholder}</main>`],
        [
          "/late",
          `${style}<main id="content"></main><script>
            addEventListener("load", () => requestAnimationFrame(() => {
              const code = document.createElement("script");
              code.src = "/reveal.js";
              document.head.append(code);
            }));
          </script>`,
        ],
      ]);

      const server = http.createServer((req, res) => {
        if (req.url === "/reveal.js") {
          res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
          res.end(`
            const content = document.getElementById("content");
            content.innerHTML = ${JSON.stringify(placeholder)};
            setTimeout(() => { content.innerHTML = ${JSON.stringify(words)}; }, 250);
          `);

          return;
        }

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"></head><body>${pages.get(req.url ?? "") ?? ""}</body></html>`,
        );
      });

      liveServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = boundPort(server);
      const browser = await launchBrowser(required(executable));
      liveBrowsers.push(browser);

      const shot = async (path: string) =>
        (await capturePage(browser, { url: `http://127.0.0.1:${port}${path}`, width: 400 })).frame
          .png;

      const reference = await shot("/reference");

      // The placeholder must change the pixels or the comparison proves
      // nothing.
      expect(reference.equals(await shot("/placeholder"))).toBe(false);
      expect((await shot("/late")).equals(reference)).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
