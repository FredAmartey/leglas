import { describe, expect, it } from "vitest";

import { previewFrameForSource, previewMessageSignal } from "./preview-message.js";

function frameFor(source: WindowProxy) {
  // SAFETY: the lookup under test reads nothing of a frame but `contentWindow`,
  // defined just below.
  const frame = {} as HTMLIFrameElement;
  Object.defineProperty(frame, "contentWindow", { value: source });

  return frame;
}

describe("preview message protocol", () => {
  it("recognizes only the two preview lifecycle messages", () => {
    expect(previewMessageSignal({ type: "leglas:preview-ready" })).toBe("ready");
    expect(previewMessageSignal({ type: "leglas:preview-error" })).toBe("error");
    expect(previewMessageSignal({ type: "leglas:preview-ready-ish" })).toBeNull();
    expect(previewMessageSignal(null)).toBeNull();
  });

  it("resolves the sender from mounted frame windows instead of message text", () => {
    // SAFETY: a window here is only ever compared by identity, never used.
    const [firstWindow, secondWindow] = [{}, {}] as [WindowProxy, WindowProxy];
    const first = frameFor(firstWindow);
    const second = frameFor(secondWindow);

    expect(previewFrameForSource([first, second], secondWindow)).toBe(second);
    expect(previewFrameForSource([first], secondWindow)).toBeNull();
    expect(previewFrameForSource([first], null)).toBeNull();
  });
});
