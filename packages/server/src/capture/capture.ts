import type { Browser, CdpPage } from "./browser.js";
import { hydrationEvidence, type HydrationEvidence } from "./hydration.js";

import { isNumber, isString, isJsonRecord, type JsonValue } from "../json.js";

/**
 * A fresh render of one direction and the places its notes name. The frame and
 * every crop come from one load, so they never mix animation frames or app
 * states, and note crops can use the live element before stale geometry.
 */

export type Focus = {
  selector: string;
  text: string;
  tag: string;
  /** Fractions of the element's box, when the note swept a region. */
  region?: { x: number; y: number; width: number; height: number } | undefined;
  /** Recorded when the note was left. Fallback only. */
  rect: { x: number; y: number; width: number; height: number };
};

export type Box = { x: number; y: number; width: number; height: number };

export type Shot = { png: Buffer; width: number; height: number };

export type CaptureInput = {
  url: string;
  width: number;
  focuses?: readonly Focus[];
  timeoutMs?: number;
};

export type CaptureOutput = {
  frame: Shot;
  /** One per focus, in order. How each was found, or null when the crop fell back to the frame. */
  crops: ({ shot: Shot; resolved: "element" | "recorded-rect" } | null)[];
  errors: string[];
  hydration: HydrationEvidence | null;
  cut: boolean;
};

export const FRAME_MAX_HEIGHT = 4000;

export const MIN_WIDTH = 320;

export const MAX_WIDTH = 3840;

export const CROP_PAD = 24;

export const CROP_MIN = { width: 320, height: 200 };

type AbortableCaptureInput = CaptureInput & { signal?: AbortSignal };

const LOCATOR = `(function (selector, text, tag) {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const wanted = norm(text).slice(0, 40);
  let el = null;
  try { el = selector ? document.querySelector(selector) : null; } catch (e) { el = null; }
  // The path survived but points somewhere else now: the words decide.
  if (el && wanted && !norm(el.textContent).includes(wanted)) el = null;
  if (!el && wanted) {
    const candidates = document.querySelectorAll(tag || "*");
    for (const c of candidates) { if (norm(c.textContent).startsWith(wanted)) { el = c; break; } }
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
})`;

/**
 * Requests that change how a page looks when they land: code (including lazy
 * components), stylesheets, fonts and images. Media and data are left out,
 * since a video streams and a page can poll forever.
 */
const DRAWN_WITH = new Set(["Script", "Stylesheet", "Font", "Image"]);

/**
 * Two painted frames, then the fonts. The frames let a render held for a
 * stylesheet or script happen; reading document.fonts.ready then lays out,
 * which starts the new words' font downloads. With frames last, it answered
 * before that layout and missed the font.
 */
const LAID_OUT = `(async () => {
  await new Promise((next) => requestAnimationFrame(() => requestAnimationFrame(next)));
  if (document.fonts) await document.fonts.ready;
  return true;
})()`;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Expand a live element or swept region into a useful crop inside the page. */
export function cropBox(
  found: Box,
  region: Focus["region"],
  bounds: { width: number; height: number },
): Box {
  const selected =
    region === undefined
      ? found
      : {
          x: found.x + found.width * region.x,
          y: found.y + found.height * region.y,
          width: found.width * region.width,
          height: found.height * region.height,
        };

  const centreX = selected.x + selected.width / 2;
  const centreY = selected.y + selected.height / 2;
  const width = Math.min(bounds.width, Math.max(CROP_MIN.width, selected.width + CROP_PAD * 2));
  const height = Math.min(bounds.height, Math.max(CROP_MIN.height, selected.height + CROP_PAD * 2));
  const x = clamp(centreX - width / 2, 0, Math.max(0, bounds.width - width));
  const y = clamp(centreY - height / 2, 0, Math.max(0, bounds.height - height));
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);

  return {
    x: roundedX,
    y: roundedY,
    width: Math.min(Math.round(width), Math.max(0, Math.round(bounds.width) - roundedX)),
    height: Math.min(Math.round(height), Math.max(0, Math.round(bounds.height) - roundedY)),
  };
}

function bounded<T>(work: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds);
    timer.unref?.();
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;

  if (signal.aborted) return Promise.reject(new Error("The page capture was abandoned."));

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("The page capture was abandoned."));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

function resultValue(response: { result?: { value?: JsonValue } } | null): JsonValue | undefined {
  const result = response?.result;

  return result !== undefined && "value" in result ? result.value : null;
}

function validBox(value: JsonValue | undefined): value is Box {
  if (!isJsonRecord(value)) return false;

  return [value.x, value.y, value.width, value.height].every(
    (entry) => isNumber(entry) && Number.isFinite(entry),
  );
}

/**
 * A log line with the path of the resource it's about. Chrome's "Failed to load
 * resource" names no file, so a broken module couldn't be told from the page
 * that imports it.
 */
function resourced(text: JsonValue | undefined, url: JsonValue | undefined): string {
  const line = String(text ?? "");

  if (!isString(url) || url === "") return line;

  try {
    return `${line} (${new URL(url).pathname})`;
  } catch {
    return line;
  }
}

function locatorExpression(focus: Focus): string {
  return `${LOCATOR}(${JSON.stringify(focus.selector)}, ${JSON.stringify(focus.text)}, ${JSON.stringify(focus.tag)})`;
}

async function render(page: CdpPage, input: CaptureInput): Promise<CaptureOutput> {
  const width = clamp(Math.round(input.width), MIN_WIDTH, MAX_WIDTH);
  const errors: string[] = [];
  let hydration: HydrationEvidence | null = null;

  const remember = (value: JsonValue | undefined) => {
    const message = String(value ?? "")
      .trim()
      .slice(0, 240);

    hydration ??= hydrationEvidence([message]);

    if (errors.length >= 10) return;

    if (message === "" || /favicon/i.test(message)) return;
    errors.push(message);
  };

  // The main document's status. The proxy turns a down dev server into a 502
  // page, and a screenshot of that labelled as the direction is worse than
  // none.
  let documentStatus: number | null = null;

  // What the page has asked for to draw with and not received, and how many
  // such requests it made. The post-load wait reads both.
  const pending = new Set<string>();
  const afterLoadScripts = new Set<string>();
  let loadFired = false;
  let scriptLanded: number | null = null;
  let asked = 0;
  let emptied = () => {};

  const received = (id: string) => {
    if (afterLoadScripts.delete(id)) scriptLanded = Date.now();

    if (pending.delete(id) && pending.size === 0) emptied();
  };

  const landed = () =>
    pending.size === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          emptied = resolve;
        });

  const unlisten = [
    page.on("Network.responseReceived", (params) => {
      if (documentStatus !== null || params?.type !== "Document") return;
      const status = params?.response?.status;

      if (isNumber(status)) documentStatus = status;
    }),
    page.on("Network.requestWillBeSent", (params) => {
      const id = params?.requestId;

      if (!DRAWN_WITH.has(params?.type) || !isString(id)) return;

      // A redirect arrives under the same id and is not a new request.
      if (!pending.has(id)) {
        asked += 1;

        if (loadFired && params?.type === "Script") afterLoadScripts.add(id);
      }

      pending.add(id);
    }),
    page.on("Network.loadingFinished", (params) => {
      if (isString(params?.requestId)) received(params.requestId);
    }),
    page.on("Network.loadingFailed", (params) => {
      if (isString(params?.requestId)) received(params.requestId);
    }),
    page.on("Runtime.exceptionThrown", (params) =>
      remember(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text),
    ),
    page.on("Runtime.consoleAPICalled", (params) => {
      if (params?.type !== "error") return;
      remember(
        Array.isArray(params.args)
          ? params.args.map((arg: any) => arg?.value ?? arg?.description ?? "").join(" ")
          : "",
      );
    }),
    page.on("Log.entryAdded", (params) => {
      if (params?.entry?.level === "error")
        remember(resourced(params.entry.text, params.entry.url));
    }),
  ];

  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    let loaded!: () => void;

    const load = new Promise<void>((resolve) => {
      loaded = resolve;
    });

    const stopLoad = page.on("Page.loadEventFired", () => {
      loadFired = true;
      loaded();
    });

    unlisten.push(stopLoad);
    const navigation = await page.send<{ errorText?: string }>("Page.navigate", { url: input.url });

    if (isString(navigation.errorText) && navigation.errorText !== "") {
      throw new Error(`The page did not load: ${navigation.errorText}`);
    }

    await bounded(load, input.timeoutMs ?? 15_000, undefined);
    stopLoad();

    if (documentStatus !== null && documentStatus >= 500) {
      throw new Error(`The page did not load: the app answered HTTP ${documentStatus}.`);
    }

    // Waits for what the page draws with. A client-rendered page draws after
    // load (React in Vite), so its stylesheets, fonts and images come after
    // load. Shot at load, a web font showed as its fallback, an image as a gap,
    // and a React 19 stylesheet with a precedence as a blank page.
    // document.fonts.ready alone knows nothing of a stylesheet in flight.
    //
    // So the wait ends when nothing is in flight and one more look (painted
    // frames, then fonts) asks for nothing new. React can hold a lazy component
    // up to 300 ms after its fallback with no request showing, so a script
    // arriving after load gets that window, then another look. Each such script
    // starts a new window within the same deadline.
    const until = Date.now() + 2_000;
    let waitedForScript: number | null = null;

    while (Date.now() < until) {
      await bounded(landed(), until - Date.now(), undefined);
      const before = asked;

      const answered = await bounded(
        page.send("Runtime.evaluate", {
          expression: LAID_OUT,
          awaitPromise: true,
          returnByValue: true,
        }),
        Math.max(0, until - Date.now()),
        undefined,
      ).then(
        () => true,
        () => false,
      );

      // A look that times out still counts; the deadline ends the loop. One
      // that fails means the page closed or crashed.
      if (!answered) break;

      if (pending.size !== 0 || asked !== before) continue;

      const latestScript = scriptLanded;

      if (latestScript === null || latestScript === waitedForScript) break;
      const remaining = Math.min(latestScript + 300, until) - Date.now();

      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      waitedForScript = latestScript;
    }

    // Settles the design before the shutter, then waits for a painted frame.
    // Caught mid-fade, an entrance animation makes each capture of a static
    // page different. Finite animations jump to their end, the design at rest.
    // It loops because pages often start their entrance a frame or two after
    // load; it stops when two passes find nothing to settle.
    //
    // Endless animations are left alone: forcing one would freeze it somewhere
    // it never sits. Those pages stay non-deterministic, and the crops still
    // land.
    await bounded(
      page.send("Runtime.evaluate", {
        expression: `(async () => {
          // The page stops itself before the caller's deadline can. Without
          // this the outer bound could win mid-finish() and the screenshot
          // would be taken while the animations it just told to settle were
          // still moving, which is the exact non-determinism this removes.
          const until = Date.now() + 1500;
          const frame = () =>
            new Promise((next) => requestAnimationFrame(() => requestAnimationFrame(next)));
          const finite = () => {
            try {
              return document.getAnimations().filter((animation) => {
                const timing = animation.effect && animation.effect.getComputedTiming();
                return timing && timing.iterations !== Infinity && isFinite(timing.endTime);
              });
            } catch (error) {
              // An engine without getAnimations. The frames still run.
              return [];
            }
          };
          let quiet = 0;
          for (let pass = 0; pass < 12 && quiet < 2 && Date.now() < until; pass += 1) {
            await frame();
            const running = finite();
            if (running.length === 0) {
              quiet += 1;
              continue;
            }
            quiet = 0;
            for (const animation of running) {
              try { animation.finish(); } catch (error) { /* refused; the bound covers it */ }
            }
          }
          await frame();
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      2_000,
      undefined,
    ).catch(() => {});

    const metrics = await page.send<{
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    }>("Page.getLayoutMetrics");

    const size = metrics.cssContentSize ?? metrics.contentSize ?? { width, height: 900 };
    const pageWidth = Math.max(width, Math.ceil(size.width));
    // The overview stops at the cap; a note can point below it, and its crop is
    // bounded by the whole document.
    const contentHeight = Math.max(1, Math.ceil(size.height));
    const pageHeight = Math.min(FRAME_MAX_HEIGHT, contentHeight);
    const cut = size.height > FRAME_MAX_HEIGHT;

    const frameResponse = await page.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: pageHeight, scale: 1 },
    });

    const frame: Shot = {
      png: Buffer.from(frameResponse.data, "base64"),
      width,
      height: pageHeight,
    };

    const crops: CaptureOutput["crops"] = [];

    for (const focus of input.focuses ?? []) {
      const located = await page.send<{ result?: { value?: JsonValue } } | null>(
        "Runtime.evaluate",
        {
          expression: locatorExpression(focus),
          returnByValue: true,
        },
      );

      const found = resultValue(located);
      let source: Box;
      let resolved: "element" | "recorded-rect";

      if (validBox(found)) {
        source = found;
        resolved = "element";
      } else {
        // The shell records viewport-relative geometry with no scroll offset,
        // accurate only if the preview wasn't scrolled, so this is a fallback
        // after the selector and the element's words.
        source = focus.rect;
        resolved = "recorded-rect";

        if (source.width < 2 || source.height < 2) {
          crops.push(null);
          continue;
        }
      }

      const box = cropBox(source, focus.region, { width: pageWidth, height: contentHeight });

      const response = await page.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { ...box, scale: 2 },
      });

      crops.push({
        shot: {
          png: Buffer.from(response.data, "base64"),
          width: box.width * 2,
          height: box.height * 2,
        },
        resolved,
      });
    }

    return { frame, crops, errors, hydration, cut };
  } finally {
    for (const stop of unlisten) stop();
  }
}

/** Capture a frame and note crops from one fresh page. */
export async function capturePage(browser: Browser, input: CaptureInput): Promise<CaptureOutput> {
  const abortInput: AbortableCaptureInput = input;

  return browser.withPage((page) => abortable(render(page, input), abortInput.signal));
}
