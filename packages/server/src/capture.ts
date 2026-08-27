import type { Browser, CdpPage } from "./browser.js";

/**
 * A fresh browser rendering of one direction and the places its notes name.
 *
 * The full frame and every crop come from one load. That keeps the prompt from
 * comparing different animation frames or application states, and lets note
 * crops use the page's live element before falling back to stale geometry.
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
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
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
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function resultValue<T>(response: unknown): T | null {
  const result = (response as { result?: { value?: unknown } } | null)?.result;
  return result !== undefined && "value" in result ? (result.value as T) : null;
}

function validBox(value: unknown): value is Box {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Partial<Box>;
  return [box.x, box.y, box.width, box.height].every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
}

function locatorExpression(focus: Focus): string {
  return `${LOCATOR}(${JSON.stringify(focus.selector)}, ${JSON.stringify(focus.text)}, ${JSON.stringify(focus.tag)})`;
}

async function render(page: CdpPage, input: CaptureInput): Promise<CaptureOutput> {
  const width = clamp(Math.round(input.width), MIN_WIDTH, MAX_WIDTH);
  const errors: string[] = [];
  const remember = (value: unknown) => {
    if (errors.length >= 10) return;
    const message = String(value ?? "").slice(0, 240);
    if (message === "" || /favicon/i.test(message)) return;
    errors.push(message);
  };
  // The main document's own answer. The proxy turns a dev server that is
  // down into a 502 text page, and a screenshot of that page labelled as the
  // direction would be worse than no screenshot at all.
  let documentStatus: number | null = null;
  const unlisten = [
    page.on("Network.responseReceived", (params) => {
      if (documentStatus !== null || params?.type !== "Document") return;
      const status = params?.response?.status;
      if (typeof status === "number") documentStatus = status;
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
      if (params?.entry?.level === "error") remember(params.entry.text);
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
    const stopLoad = page.on("Page.loadEventFired", () => loaded());
    unlisten.push(stopLoad);
    const navigation = await page.send<{ errorText?: string }>("Page.navigate", { url: input.url });
    if (typeof navigation.errorText === "string" && navigation.errorText !== "") {
      throw new Error(`The page did not load: ${navigation.errorText}`);
    }
    await bounded(load, input.timeoutMs ?? 15_000, undefined);
    stopLoad();
    if (documentStatus !== null && documentStatus >= 500) {
      throw new Error(`The page did not load: the app answered HTTP ${documentStatus}.`);
    }
    await bounded(
      page.send("Runtime.evaluate", {
        expression: "document.fonts ? document.fonts.ready.then(() => true) : true",
        awaitPromise: true,
        returnByValue: true,
      }),
      2_000,
      undefined,
    ).catch(() => {});
    // Settle the design before the shutter, then wait for a painted frame.
    //
    // An entrance animation is the thing that makes two captures of one
    // static page disagree: caught mid-fade, the same design comes back
    // different every time, which is useless to an agent asked to judge it.
    // A flat wait was the old answer and it only worked by outlasting the
    // animations it happened to be longer than.
    //
    // So the finite ones are jumped to their end, which is the design at
    // rest and the thing a screenshot is meant to show. It loops because a
    // page commonly starts its entrance a frame or two after load, so one
    // pass finishes nothing and the shutter still catches the fade; the loop
    // ends when two passes running find nothing left to settle.
    //
    // Anything endless is left alone: a looping background cannot be waited
    // out, and forcing it would freeze it somewhere it never sits. Those
    // pages stay non-deterministic, which is honest, and the crops still land.
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
    // The overview frame stops at the cap; a note can point below it, and
    // its crop is bounded by the whole document rather than by the frame.
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
      const located = await page.send("Runtime.evaluate", {
        expression: locatorExpression(focus),
        returnByValue: true,
      });
      const found = resultValue<unknown>(located);
      let source: Box;
      let resolved: "element" | "recorded-rect";
      if (validBox(found)) {
        source = found;
        resolved = "element";
      } else {
        // The shell records viewport-relative geometry with no scroll offset.
        // It is page-accurate only when the preview was not scrolled, so this
        // stays a fallback after the selector and the element's words fail.
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

    return { frame, crops, errors, cut };
  } finally {
    for (const stop of unlisten) stop();
  }
}

/** Capture a frame and note crops from one fresh page. */
export async function capturePage(
  browser: Browser,
  input: CaptureInput,
): Promise<CaptureOutput> {
  const abortInput = input as AbortableCaptureInput;
  return browser.withPage((page) => abortable(render(page, input), abortInput.signal));
}
