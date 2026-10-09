import { afterEach, describe, expect, test, vi } from "vitest";

import { updateNote } from "./annotations-api.js";
import type { JsonValue } from "../json.js";

/** Answers every call with `body`, and records each one. */
function serve(body: JsonValue, status = 200) {
  const calls: { input: string; init?: RequestInit }[] = [];

  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    calls.push(init === undefined ? { input } : { input, init });

    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  });

  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("rewording a note", () => {
  test("sends the id and the new words, and nothing else", async () => {
    const calls = serve({ annotation: { id: "a1", note: "looks printed" }, ok: true });

    await expect(updateNote("a1", "looks printed")).resolves.toMatchObject({
      annotation: { note: "looks printed" },
    });
    expect(calls).toEqual([
      {
        init: {
          body: JSON.stringify({ id: "a1", note: "looks printed" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
        input: "/leglas/api/annotations/update",
      },
    ]);
  });

  // A note the server no longer knows is about to leave the pane anyway. It
  // must reject so the interface can say the words weren't kept.
  test("refuses when the note is no longer there", async () => {
    serve({ error: "That note has gone.", ok: false }, 404);

    await expect(updateNote("gone", "looks printed")).rejects.toThrow();
  });
});
