import { describe, expect, test } from "vitest";

import type { JsonValue } from "../json.js";
import { frameRefusal, refusalWords } from "./framing.js";

const answering =
  (body: JsonValue, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("frameRefusal", () => {
  test("names the header that refused the frame", async () => {
    const refusal = await frameRefusal(
      "Docs",
      answering({ framable: false, refusal: { header: "x-frame-options", value: "DENY" } }),
    );

    expect(refusal).toEqual({ header: "x-frame-options", value: "DENY" });
  });

  test("anything short of a clear refusal leaves the pane alone", async () => {
    expect(await frameRefusal("Docs", answering({ framable: true }))).toBeNull();
    // Unknown: the page did not answer, which is the frame's own story to tell.
    expect(await frameRefusal("Docs", answering({ framable: null }))).toBeNull();
    // A viewer is refused the route; an older server does not have it.
    expect(await frameRefusal("Docs", answering({ error: "no" }, 403))).toBeNull();
    expect(await frameRefusal("Docs", answering({ framable: false, refusal: "DENY" }))).toBeNull();

    const failing: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };

    expect(await frameRefusal("Docs", failing)).toBeNull();
  });
});

describe("refusalWords", () => {
  const shell = "http://localhost:4100";

  const said = (words: { lead: string; quote: string; tail: string }) =>
    `${words.lead}${words.quote}${words.tail}`;

  test("says which site refused, and why, in the header's own words", () => {
    const deny = refusalWords(
      { header: "x-frame-options", value: "DENY" },
      "https://docs.example.com/start",
      shell,
    );

    expect(deny.headline).toBe("docs.example.com won’t open inside another page");
    // The header's words are set apart, so they can be shown as the site sent them.
    expect(deny.reason).toEqual({
      lead: "It sends ",
      quote: "X-Frame-Options: DENY",
      tail: ", which tells every browser not to show it in a frame.",
    });

    expect(
      said(
        refusalWords({ header: "x-frame-options", value: "SAMEORIGIN" }, "https://x.dev/", shell)
          .reason,
      ),
    ).toBe("It sends X-Frame-Options: SAMEORIGIN, which lets only its own pages frame it.");

    expect(
      said(
        refusalWords(
          { header: "content-security-policy", value: "frame-ancestors 'none'" },
          "https://x.dev/",
          shell,
        ).reason,
      ),
    ).toBe(
      "Its Content-Security-Policy says frame-ancestors 'none', and Leglas is not on that list.",
    );
  });

  test("tells the site's owner the one header that would change it", () => {
    const hint = refusalWords(
      { header: "x-frame-options", value: "DENY" },
      "https://x.dev/",
      shell,
    ).hint;

    expect(hint.quote).toBe("frame-ancestors http://localhost:4100");
    expect(said(hint)).toBe(
      "If the site is yours, a Content-Security-Policy of frame-ancestors http://localhost:4100 lets it show here.",
    );
  });
});
