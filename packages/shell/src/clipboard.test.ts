import { describe, expect, test, vi } from "vitest";

import { copyText } from "./clipboard.js";

const clipboard = (result: Promise<void>) => ({ writeText: vi.fn(() => result) });

describe("copyText", () => {
  test("uses the async clipboard when it works", async () => {
    const async = clipboard(Promise.resolve());
    const legacy = vi.fn(() => true);
    await expect(copyText("https://x.test/a", { clipboard: async, legacy })).resolves.toBe("copied");
    expect(async.writeText).toHaveBeenCalledWith("https://x.test/a");
    expect(legacy).not.toHaveBeenCalled();
  });

  test("falls back when permission is refused rather than reporting failure", async () => {
    const legacy = vi.fn(() => true);
    const outcome = await copyText("url", {
      clipboard: clipboard(Promise.reject(new Error("denied"))),
      legacy,
    });
    expect(outcome).toBe("copied");
    expect(legacy).toHaveBeenCalledWith("url");
  });

  // The shell is reachable over a LAN address, where the async clipboard is
  // absent entirely rather than present and failing.
  test("falls back when there is no async clipboard at all", async () => {
    await expect(copyText("url", { legacy: () => true })).resolves.toBe("copied");
  });

  test("reports blocked when neither path lands", async () => {
    const outcome = await copyText("url", {
      clipboard: clipboard(Promise.reject(new Error("denied"))),
      legacy: () => false,
    });
    expect(outcome).toBe("blocked");
  });

  test("reports blocked rather than throwing when the legacy command is gone", async () => {
    const outcome = await copyText("url", {
      legacy: () => {
        throw new Error("execCommand removed");
      },
    });
    expect(outcome).toBe("blocked");
  });

  test("reports blocked when the environment offers nothing", async () => {
    await expect(copyText("url", {})).resolves.toBe("blocked");
  });
});
