import { describe, expect, test } from "vitest";

import {
  REFERENCE_BYTES_CAP,
  admit,
  carriesFiles,
  describeBytes,
  displayName,
  headerName,
  referenceIds,
  refusalMessage,
  sendBlocker,
  type ReferenceDraft,
} from "./references.js";

const png = (name = "shot.png", size = 1024) => ({ name, type: "image/png", size });

const draft = (overrides: Partial<ReferenceDraft> = {}): ReferenceDraft => ({
  key: "k",
  name: "shot.png",
  type: "image/png",
  bytes: 1024,
  url: "blob:x",
  status: "ready",
  id: "abc",
  ...overrides,
});

describe("admit", () => {
  // The server's suite uploads at this cap and one byte over, so with one
  // shared number a refusal here is a refusal there.
  test("refuses at exactly the server's limit, so a retry can never fix a refusal", () => {
    const edge = png("edge.png", REFERENCE_BYTES_CAP);
    const over = png("over.png", REFERENCE_BYTES_CAP + 1);

    expect(admit([], [edge, over])).toEqual({
      accepted: [edge],
      refused: [{ file: over, why: "too-big" }],
    });
  });

  test("takes images up to the cap, counting what is already attached", () => {
    // Two slots left. An oversized file offered first spends none of them.
    const current = [draft({ key: "1" }), draft({ key: "2" })];
    const big = png("huge.png", REFERENCE_BYTES_CAP + 1);
    const offered = [big, png("a.png"), png("b.png"), png("c.png")];
    const { accepted, refused } = admit(current, offered);
    expect(accepted.map((file) => file.name)).toEqual(["a.png", "b.png"]);
    expect(refused).toEqual([
      { file: big, why: "too-big" },
      { file: offered[3], why: "too-many" },
    ]);
  });

  test("refuses what is not an image, whatever it is called", () => {
    const svg = { name: "logo.png", type: "image/svg+xml", size: 10 };
    expect(admit([], [svg]).refused).toEqual([{ file: svg, why: "not-an-image" }]);
  });
});

describe("refusalMessage", () => {
  test("explains the cap in the strip's own terms, and says nothing when nothing was refused", () => {
    expect(refusalMessage([])).toBeNull();
    expect(refusalMessage([{ file: png(), why: "too-many" }])).toBe(
      "Up to 4 images can ride with a change. One was left off.",
    );
    expect(
      refusalMessage([
        { file: png(), why: "too-many" },
        { file: png(), why: "too-many" },
      ]),
    ).toBe("Up to 4 images can ride with a change. 2 were left off.");
  });

  test("names the file that was not an image", () => {
    expect(
      refusalMessage([
        { file: { name: "deck.pdf", type: "application/pdf", size: 1 }, why: "not-an-image" },
      ]),
    ).toBe("deck.pdf is not an image Leglas can attach. PNG, JPEG, WebP or GIF.");
  });

  test("the first reason speaks for a batch", () => {
    const message = refusalMessage([
      { file: png("big.png", REFERENCE_BYTES_CAP + 1), why: "too-big" },
      { file: png(), why: "too-many" },
    ]);

    expect(message).toContain("over 10MB");
  });
});

describe("names and sizes", () => {
  test("a nameless paste is still called something, and its header form is bounded ascii", () => {
    expect(displayName("   ")).toBe("image");
    expect(displayName(" Screenshot  2026.png ")).toBe("Screenshot 2026.png");
    expect(headerName("café ☕.png")).toBe("caf .png");
    expect(headerName("\u0000\u0001")).toBe("image");
    expect(headerName("x".repeat(200))).toHaveLength(80);
  });

  test("bytes read the way people say them", () => {
    expect(describeBytes(512)).toBe("512 B");
    expect(describeBytes(20 * 1024)).toBe("20 KB");
    expect(describeBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(describeBytes(12 * 1024 * 1024)).toBe("12 MB");
  });
});

describe("what a request names", () => {
  test("only uploads that landed become ids, and a failed one blocks the send", () => {
    const drafts = [
      draft({ key: "1", id: "a" }),
      draft({ key: "2", status: "uploading", id: null }),
      draft({ key: "3", status: "failed", id: null }),
      draft({ key: "4", id: "d" }),
    ];

    expect(referenceIds(drafts)).toEqual(["a", "d"]);
    // A failure needs a decision, so it outranks an upload in flight, which
    // only waits; a clean set sends.
    expect(sendBlocker(drafts)).toBe("failed");
    expect(sendBlocker([draft({ status: "failed", id: null })])).toBe("failed");
    expect(sendBlocker([draft({ status: "uploading", id: null }), draft()])).toBe("uploading");
    expect(sendBlocker([draft(), draft({ key: "2" })])).toBeNull();
    expect(sendBlocker([])).toBeNull();
  });
});

describe("carriesFiles", () => {
  test("reads the drag's declared types", () => {
    expect(carriesFiles(["text/plain", "Files"])).toBe(true);
    expect(carriesFiles(["text/uri-list"])).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });
});
