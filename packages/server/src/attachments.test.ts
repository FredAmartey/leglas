import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { Annotation } from "./annotations.js";
import {
  CAPTURES_DIR,
  LOAD_SHARE,
  REFERENCES_DIR,
  attachRequest,
  isOwnCapture,
  previewUrl,
  pruneCaptures,
  pruneReferences,
  rehomeCaptures,
  rehomeText,
  removeCaptures,
  sniffImage,
} from "./attachments.js";
import type { Browser, BrowserPool, CdpPage } from "./browser.js";
import { NO_BROWSER } from "./browser.js";
import type { CaptureOutput } from "./capture.js";
import type { Preview } from "./config.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "leglas-attachments-"));
}

function preview(title: string, url: string, extra: Partial<Preview> = {}): Preview {
  return { title, url, note: undefined, tags: [], ...extra };
}

function note(id: string, text: string): Annotation {
  return {
    id,
    title: "Poster",
    note: text,
    anchor: {
      selector: `#${id}`,
      text,
      tag: "p",
      classes: [],
      rect: { x: 10, y: 20, width: 200, height: 40 },
      spot: { x: 0.5, y: 0.5 },
      viewport: 1440,
    },
  };
}

const fakeBrowser: Browser = {
  closed: false,
  close: async () => {},
  withPage: async <T,>(work: (page: CdpPage) => Promise<T>) => work({} as CdpPage),
};

function pool(browser: Browser | null, reason = NO_BROWSER): BrowserPool {
  return {
    acquire: async () => browser,
    reason: () => (browser === null ? reason : null),
    close: async () => {},
  };
}

/** A capture whose shots are recognisable by their bytes. */
function shot(name: string, width = 800, height = 600) {
  return { png: Buffer.from(name), width, height };
}

function capture(overrides: Partial<CaptureOutput> = {}): CaptureOutput {
  return {
    frame: shot("frame"),
    crops: [],
    errors: [],
    cut: false,
    ...overrides,
  };
}

/** A 2x3 PNG, real enough for the size sniffer to read its header. */
const PNG = (() => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(3, 20);
  return bytes;
})();

describe("previewUrl", () => {
  test("resolves project routes and leaves absolute previews alone", () => {
    expect(previewUrl("http://127.0.0.1:4100", preview("Poster", "/?v-hero=poster"))).toBe(
      "http://127.0.0.1:4100/?v-hero=poster",
    );
    expect(previewUrl("http://127.0.0.1:4100", preview("Staging", "https://staging.example.com/x"))).toBe(
      "https://staging.example.com/x",
    );
  });
});

describe("sniffImage", () => {
  test("reads each supported container from its own bytes", () => {
    expect(sniffImage(PNG)).toEqual({ kind: "png", width: 2, height: 3 });

    const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(4)]);
    gif.writeUInt16LE(12, 6);
    gif.writeUInt16LE(9, 8);
    expect(sniffImage(gif)).toEqual({ kind: "gif", width: 12, height: 9 });

    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt16BE(40, 0);
        size.writeUInt16BE(60, 2);
        return size;
      })(),
      Buffer.alloc(20),
    ]);
    expect(sniffImage(jpeg)).toMatchObject({ kind: "jpg", width: 60, height: 40 });

    const webp = Buffer.alloc(40);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(sniffImage(webp)).toEqual({ kind: "webp", width: 100, height: 50 });
  });

  test("a recognised container whose dimensions cannot be read still names itself", () => {
    const truncated = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(sniffImage(truncated)).toEqual({ kind: "png", width: 0, height: 0 });
  });

  test("anything else is not an image", () => {
    expect(sniffImage(Buffer.from("<svg/>", "utf8"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("attachRequest", () => {
  test("writes the frame, numbered notes, comparison and moved references", async () => {
    const cwd = root();
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    writeFileSync(join(cwd, REFERENCES_DIR, "paste1.png"), PNG);

    const captured = vi
      .fn()
      .mockResolvedValueOnce(
        capture({
          frame: shot("frame", 390, 900),
          crops: [
            { shot: shot("note-one", 700, 400), resolved: "element" },
            { shot: shot("note-two", 700, 400), resolved: "recorded-rect" },
          ],
          errors: ["boom"],
        }),
      )
      .mockResolvedValueOnce(capture({ frame: shot("compare", 390, 900) }));

    const result = await attachRequest(
      cwd,
      "req1",
      {
        origin: "http://127.0.0.1:4100",
        preview: preview("Poster", "/"),
        width: 390,
        notes: [note("n1", "too heavy"), note("n2", "too tight")],
        compare: preview("Ledger", "/ledger"),
        references: ["paste1"],
      },
      { pool: pool(fakeBrowser), capture: captured },
    );

    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual(["boom"]);
    expect(result.attachments).toEqual([
      {
        kind: "frame",
        file: `${CAPTURES_DIR}/req1/frame.png`,
        width: 390,
        height: 900,
        title: "Poster",
        viewport: 390,
      },
      {
        kind: "note",
        file: `${CAPTURES_DIR}/req1/note-1.png`,
        width: 700,
        height: 400,
        title: "Poster",
        note: "n1",
        viewport: 390,
      },
      {
        kind: "note",
        file: `${CAPTURES_DIR}/req1/note-2.png`,
        width: 700,
        height: 400,
        title: "Poster",
        note: "n2",
        viewport: 390,
      },
      {
        kind: "compare",
        file: `${CAPTURES_DIR}/req1/compare.png`,
        width: 390,
        height: 900,
        title: "Ledger",
        viewport: 390,
      },
      {
        kind: "reference",
        file: `${CAPTURES_DIR}/req1/reference-1.png`,
        width: 2,
        height: 3,
      },
    ]);

    // Every path in the record is a file that is actually there.
    for (const attachment of result.attachments) {
      expect(existsSync(join(cwd, attachment.file))).toBe(true);
    }
    expect(readFileSync(join(cwd, CAPTURES_DIR, "req1", "note-1.png"), "utf8")).toBe("note-one");
    // The upload moved rather than copied, so nothing is left to prune.
    expect(existsSync(join(cwd, REFERENCES_DIR, "paste1.png"))).toBe(false);
    // One load for the direction and its notes, one for the compared pane.
    expect(captured).toHaveBeenCalledTimes(2);
    expect((captured.mock.calls[0]?.[1] as { url: string }).url).toBe("http://127.0.0.1:4100/");
    expect((captured.mock.calls[1]?.[1] as { url: string }).url).toBe("http://127.0.0.1:4100/ledger");
  });

  test("a note whose crop could not be taken is left out rather than misnumbered", async () => {
    const cwd = root();
    const captured = vi.fn().mockResolvedValue(
      capture({ crops: [null, { shot: shot("second"), resolved: "element" }] }),
    );

    const result = await attachRequest(
      cwd,
      "req2",
      {
        origin: "http://127.0.0.1:4100",
        preview: preview("Poster", "/"),
        width: 1440,
        notes: [note("n1", "gone"), note("n2", "here")],
        compare: null,
        references: [],
      },
      { pool: pool(fakeBrowser), capture: captured },
    );

    const notes = result.attachments.filter((attachment) => attachment.kind === "note");
    expect(notes).toHaveLength(1);
    // The number follows the note it belongs to, so the prompt's "note 2"
    // and the file agree.
    expect(notes[0]).toMatchObject({ file: `${CAPTURES_DIR}/req2/note-2.png`, note: "n2" });
  });

  test("moves references even when no browser can be found", async () => {
    const cwd = root();
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    writeFileSync(join(cwd, REFERENCES_DIR, "paste1.png"), PNG);

    const result = await attachRequest(
      cwd,
      "req3",
      {
        origin: "http://127.0.0.1:4100",
        preview: preview("Poster", "/"),
        width: 1440,
        notes: [],
        compare: null,
        references: ["paste1"],
      },
      { pool: pool(null) },
    );

    // A pasted image is worth carrying whatever else failed, and the request
    // says in one sentence why there is no render beside it.
    expect(result.skipped).toBe(NO_BROWSER);
    expect(result.attachments).toEqual([
      { kind: "reference", file: `${CAPTURES_DIR}/req3/reference-1.png`, width: 2, height: 3 },
    ]);
  });

  test("honours one deadline and returns without waiting for a stuck capture", async () => {
    const cwd = root();
    const capture = vi.fn(() => new Promise<CaptureOutput>(() => {}));
    const started = Date.now();
    const result = await attachRequest(
      cwd,
      "slow",
      {
        origin: "http://127.0.0.1:4100",
        preview: preview("Slow", "/"),
        width: 800,
        notes: [],
        compare: null,
        references: [],
      },
      { pool: pool(fakeBrowser), capture, deadlineMs: 20 },
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.skipped).toBe("The design could not be captured in time.");
    expect(result.attachments).toEqual([]);
    expect((capture.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    // The load gets a share of the deadline, so a page that rendered but
    // never fired load is still captured before the deadline lands.
    expect((capture.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBe(
      Math.floor(20 * LOAD_SHARE),
    );
  });

  test("a page that will not load is reported rather than thrown", async () => {
    const cwd = root();
    const capture = vi.fn(async () => {
      throw new Error("The page did not load: net::ERR_CONNECTION_REFUSED");
    });

    const result = await attachRequest(
      cwd,
      "down",
      {
        origin: "http://127.0.0.1:4100",
        preview: preview("Poster", "/"),
        width: 1440,
        notes: [],
        compare: null,
        references: [],
      },
      { pool: pool(fakeBrowser), capture },
    );

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toContain("ERR_CONNECTION_REFUSED");
  });
});

describe("rehomeCaptures", () => {
  test("moves the directory and repoints every path at it", async () => {
    const cwd = root();
    mkdirSync(join(cwd, CAPTURES_DIR, "old"), { recursive: true });
    writeFileSync(join(cwd, CAPTURES_DIR, "old", "frame.png"), "frame");

    const moved = await rehomeCaptures(cwd, "old", "new", [
      { kind: "frame", file: `${CAPTURES_DIR}/old/frame.png`, width: 1, height: 1 },
    ]);

    expect(moved).toEqual([
      { kind: "frame", file: `${CAPTURES_DIR}/new/frame.png`, width: 1, height: 1 },
    ]);
    expect(readFileSync(join(cwd, CAPTURES_DIR, "new", "frame.png"), "utf8")).toBe("frame");
    expect(existsSync(join(cwd, CAPTURES_DIR, "old"))).toBe(false);
  });
});

describe("rehomeText", () => {
  test("points every capture path at the new directory and nothing else", () => {
    const text =
      "see .leglas/captures/abc/frame.png and .leglas/captures/abc/note-1.png, not .leglas/captures/abcd/x.png";
    expect(rehomeText(text, "abc", "xyz")).toBe(
      "see .leglas/captures/xyz/frame.png and .leglas/captures/xyz/note-1.png, not .leglas/captures/abcd/x.png",
    );
  });
});

describe("capture cleanup", () => {
  test("removes one request and prunes everything not kept except show", async () => {
    const cwd = root();
    for (const name of ["keep", "drop", "show"]) {
      mkdirSync(join(cwd, CAPTURES_DIR, name), { recursive: true });
      writeFileSync(join(cwd, CAPTURES_DIR, name, "frame.png"), "frame");
    }

    await removeCaptures(cwd, "drop");
    expect(existsSync(join(cwd, CAPTURES_DIR, "drop"))).toBe(false);

    mkdirSync(join(cwd, CAPTURES_DIR, "orphan"), { recursive: true });
    await pruneCaptures(cwd, ["keep"]);

    // `show` is not a request and outlives the queue that never claimed it.
    expect(readdirSync(join(cwd, CAPTURES_DIR)).sort()).toEqual(["keep", "show"]);
  });

  test("drops references older than an hour and leaves fresh ones", async () => {
    const cwd = root();
    mkdirSync(join(cwd, REFERENCES_DIR), { recursive: true });
    const stale = join(cwd, REFERENCES_DIR, "stale.png");
    const fresh = join(cwd, REFERENCES_DIR, "fresh.png");
    writeFileSync(stale, PNG);
    writeFileSync(fresh, PNG);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    await pruneReferences(cwd);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a project that never captured anything is left untouched", async () => {
    const cwd = root();
    await expect(pruneCaptures(cwd, [])).resolves.toBeUndefined();
    await expect(removeCaptures(cwd, "nothing")).resolves.toBeUndefined();
    expect(existsSync(join(cwd, ".leglas"))).toBe(false);
  });
});

describe("what a removal may touch", () => {
  test("an id that is not one Leglas minted removes nothing", async () => {
    const cwd = root();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "keep.ts"), "export {};");
    mkdirSync(join(cwd, CAPTURES_DIR, "real"), { recursive: true });

    await removeCaptures(cwd, "../../src");
    await removeCaptures(cwd, "real/../../src");
    expect(existsSync(join(cwd, "src", "keep.ts"))).toBe(true);

    await removeCaptures(cwd, "real");
    expect(existsSync(join(cwd, CAPTURES_DIR, "real"))).toBe(false);
  });
});

describe("links standing where Leglas's own directories should be", () => {
  test("a symlinked captures directory is left alone instead of emptied", async () => {
    const cwd = root();
    // Somewhere with real work in it, and .leglas/captures pointing at it.
    mkdirSync(join(cwd, "elsewhere", "src"), { recursive: true });
    writeFileSync(join(cwd, "elsewhere", "src", "keep.ts"), "export {};");
    mkdirSync(join(cwd, ".leglas"), { recursive: true });
    symlinkSync(join(cwd, "elsewhere"), join(cwd, CAPTURES_DIR));

    await pruneCaptures(cwd, []);

    expect(existsSync(join(cwd, "elsewhere", "src", "keep.ts"))).toBe(true);
  });

  test("a link inside the captures directory is not an image this project owns", async () => {
    const cwd = root();
    mkdirSync(join(cwd, CAPTURES_DIR, "abc"), { recursive: true });
    writeFileSync(join(cwd, "private.png"), "secret");
    writeFileSync(join(cwd, CAPTURES_DIR, "abc", "frame.png"), "frame");
    symlinkSync(join(cwd, "private.png"), join(cwd, CAPTURES_DIR, "abc", "leak.png"));

    expect(await isOwnCapture(cwd, `${CAPTURES_DIR}/abc/frame.png`)).toBe(true);
    expect(await isOwnCapture(cwd, `${CAPTURES_DIR}/abc/leak.png`)).toBe(false);
    expect(await isOwnCapture(cwd, "private.png")).toBe(false);
    expect(await isOwnCapture(cwd, `${CAPTURES_DIR}/abc`)).toBe(false);
  });
});
