import { describe, expect, test } from "vitest";

import { updateNote, type NoteFetcher } from "./annotations-api.js";

function recorder(body: unknown = { ok: true }, status = 200) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher: NoteFetcher = async (input, init) => {
    calls.push(init === undefined ? { input } : { input, init });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  };
  return { calls, fetcher };
}

describe("rewording a note", () => {
  test("sends the id and the new words, and nothing else", async () => {
    const recorded = recorder({ annotation: { id: "a1", note: "looks printed" }, ok: true });

    await expect(updateNote("a1", "looks printed", recorded.fetcher)).resolves.toMatchObject({
      annotation: { note: "looks printed" },
    });
    expect(recorded.calls).toEqual([
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

  // A note whose id the server no longer recognises is one the poll is about
  // to take off the pane anyway. It has to reject rather than resolve, so the
  // interface can say the words were not kept.
  test("refuses when the note is no longer there", async () => {
    const recorded = recorder({ error: "That note has gone.", ok: false }, 404);

    await expect(updateNote("gone", "looks printed", recorded.fetcher)).rejects.toThrow();
  });
});
