import { describe, expect, test } from "vitest";

import type { Annotation } from "./annotations.js";
import type { Preview } from "./config.js";
import type { PendingRequest } from "./requests.js";
import { composeEntry } from "./log.js";

const preview = (over: Partial<Preview> & { title: string }): Preview => ({
  url: "/",
  note: undefined,
  tags: [],
  ...over,
});

const request = (over: Partial<PendingRequest> & { title: string }): PendingRequest =>
  ({
    id: "r1",
    status: "done",
    url: "/",
    intent: "",
    target: null,
    prompt: "",
    ...over,
  }) as PendingRequest;

describe("composeEntry", () => {
  test("names the winner, where it went, and how many it beat", () => {
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Table", to: "src/Hero.tsx" },
      previews: [preview({ title: "Table" }), preview({ title: "Menu" })],
      requests: [],
      annotations: [],
      date: "2026-08-27",
    });

    expect(entry.slug).toBe("2026-08-27-hero");
    expect(entry.markdown).toContain("**Table** won and became `src/Hero.tsx`");
    expect(entry.markdown).toContain("2 directions were compared");
    expect(entry.markdown).toContain("## Table — kept");
    expect(entry.markdown).toContain("## Menu");
  });

  test("carries the words that were typed, not a summary of them", () => {
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Table", to: "src/Hero.tsx" },
      previews: [preview({ title: "Table" })],
      requests: [
        request({ title: "Table", intent: "warm the scrim so the headline reads" }),
        request({ title: "Table", id: "r2", intent: "one step larger" }),
      ],
      annotations: [],
      date: "2026-08-27",
    });

    expect(entry.markdown).toContain("- warm the scrim so the headline reads");
    expect(entry.markdown).toContain("- one step larger");
  });

  test("invents nothing for a direction with no note", () => {
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Bare", to: "src/Hero.tsx" },
      previews: [preview({ title: "Bare" })],
      requests: [],
      annotations: [],
      date: "2026-08-27",
    });

    // The heading, the summary line, and nothing else about it.
    expect(entry.markdown).not.toContain("Asked for");
    expect(entry.markdown).not.toContain("Marked on the design");
    expect(entry.pictures).toEqual([]);
  });

  test("takes a direction's last frame, so a changed one shows its later self", () => {
    const frame = (file: string) => ({ kind: "frame" as const, file, width: 1, height: 1 });
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Table", to: "src/Hero.tsx" },
      previews: [preview({ title: "Table" })],
      requests: [
        request({ title: "Table", attachments: [frame(".leglas/captures/a/frame.png")] }),
        request({ title: "Table", id: "r2", attachments: [frame(".leglas/captures/b/frame.png")] }),
      ],
      annotations: [],
      date: "2026-08-27",
    });

    expect(entry.pictures).toEqual([{ from: ".leglas/captures/b/frame.png", to: "table.png" }]);
    expect(entry.markdown).toContain("![Table](2026-08-27-hero/table.png)");
  });

  test("records the pins left on a direction", () => {
    const note = (over: Partial<Annotation>): Annotation =>
      ({ id: "a1", title: "Table", note: "", anchor: {}, ...over }) as Annotation;
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Table", to: "src/Hero.tsx" },
      previews: [preview({ title: "Table" })],
      requests: [],
      annotations: [note({ note: "the fork crops badly here" })],
      date: "2026-08-27",
    });

    expect(entry.markdown).toContain("- the fork crops badly here");
  });

  test("keeps what failed, because a rejected change is part of the record", () => {
    const entry = composeEntry({
      surface: "hero",
      won: { title: "Table", to: "src/Hero.tsx" },
      previews: [preview({ title: "Table" })],
      requests: [
        request({
          title: "Table",
          status: "failed",
          intent: "try it in olive",
          failure: { code: "not-signed-in", message: "the provider refused the login" },
        }),
      ],
      annotations: [],
      date: "2026-08-27",
    });

    expect(entry.markdown).toContain("## Changes that did not land");
    expect(entry.markdown).toContain("try it in olive (the provider refused the login)");
    // Once, at the foot. Listing it as something asked for reads as though it happened.
    expect(entry.markdown).not.toContain("Asked for");
  });

  test("a title that is only punctuation still produces a usable filename", () => {
    const entry = composeEntry({
      surface: "!!!",
      won: { title: "???", to: "src/Hero.tsx" },
      previews: [preview({ title: "???" })],
      requests: [],
      annotations: [],
      date: "2026-08-27",
    });

    expect(entry.slug).toBe("2026-08-27-untitled");
  });
});
