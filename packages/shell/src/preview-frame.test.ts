import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  markPreviewLoaded,
  previewFrameIsReady,
  previewIdentity,
  previewIsLoaded,
  resetPreviewLoaded,
  watchPreviewFrame,
} from "./preview-frame.js";

function fakeFrame(
  initial: { href: string; readyState: DocumentReadyState } | null,
) {
  let documentState = initial;
  const frame = new EventTarget() as HTMLIFrameElement;
  Object.defineProperty(frame, "contentDocument", {
    configurable: true,
    get: () =>
      documentState === null
        ? null
        : ({
            location: { href: documentState.href },
            readyState: documentState.readyState,
          } as Document),
  });
  return {
    frame,
    setDocument: (next: typeof documentState) => {
      documentState = next;
    },
  };
}

describe("preview iframe readiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recognizes a cached same-origin document immediately", () => {
    const { frame } = fakeFrame({ href: "http://localhost:4103/", readyState: "complete" });
    const onReady = vi.fn();
    const onFailure = vi.fn();

    watchPreviewFrame({ frame, onFailure, onReady, sameOrigin: true, timeoutMs: 15_000 });

    expect(previewFrameIsReady(frame)).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15_000);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("waits through about:blank and accepts the real load event", () => {
    const { frame, setDocument } = fakeFrame({ href: "about:blank", readyState: "complete" });
    const onReady = vi.fn();
    const onFailure = vi.fn();

    watchPreviewFrame({ frame, onFailure, onReady, sameOrigin: true, timeoutMs: 15_000 });
    expect(onReady).not.toHaveBeenCalled();

    setDocument({ href: "http://localhost:4103/", readyState: "interactive" });
    frame.dispatchEvent(new Event("load"));

    expect(onReady).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("treats a cross-origin load event as the only available success signal", () => {
    const { frame } = fakeFrame(null);
    const onReady = vi.fn();

    watchPreviewFrame({
      frame,
      onFailure: vi.fn(),
      onReady,
      sameOrigin: false,
      timeoutMs: 15_000,
    });
    frame.dispatchEvent(new Event("load"));

    expect(onReady).toHaveBeenCalledOnce();
  });

  it("checks the rendered document once more before timing out", () => {
    const { frame, setDocument } = fakeFrame({ href: "about:blank", readyState: "complete" });
    const onReady = vi.fn();
    const onFailure = vi.fn();

    watchPreviewFrame({ frame, onFailure, onReady, sameOrigin: true, timeoutMs: 15_000 });
    setDocument({ href: "http://localhost:4103/", readyState: "complete" });
    vi.advanceTimersByTime(15_000);

    expect(onReady).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a real navigation failure exactly once", () => {
    const { frame } = fakeFrame(null);
    const onFailure = vi.fn();

    watchPreviewFrame({
      frame,
      onFailure,
      onReady: vi.fn(),
      sameOrigin: true,
      timeoutMs: 15_000,
    });
    frame.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(15_000);

    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("removes listeners and timers when its owner unmounts", () => {
    const { frame } = fakeFrame(null);
    const onReady = vi.fn();
    const onFailure = vi.fn();
    const stop = watchPreviewFrame({
      frame,
      onFailure,
      onReady,
      sameOrigin: true,
      timeoutMs: 15_000,
    });

    stop();
    frame.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(15_000);

    expect(onReady).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("preview loading identity", () => {
  it("separates URL changes and explicit reloads of one title", () => {
    const first = previewIdentity("Aurora", "/?v=one", 0);
    const changed = previewIdentity("Aurora", "/?v=two", 0);
    const reloaded = previewIdentity("Aurora", "/?v=one", 1);
    const loaded = markPreviewLoaded({}, "Aurora", first);

    expect(previewIsLoaded(loaded, "Aurora", first)).toBe(true);
    expect(previewIsLoaded(loaded, "Aurora", changed)).toBe(false);
    expect(previewIsLoaded(loaded, "Aurora", reloaded)).toBe(false);
  });

  it("forgets a prior mount before the same identity is shown again", () => {
    const identity = previewIdentity("Aurora", "/?v=one", 0);
    const loaded = markPreviewLoaded({}, "Aurora", identity);

    expect(resetPreviewLoaded(loaded, "Aurora")).toEqual({});
    expect(resetPreviewLoaded({}, "Aurora")).toEqual({});
  });
});
