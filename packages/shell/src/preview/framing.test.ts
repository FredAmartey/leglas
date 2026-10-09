import { afterEach, describe, expect, test, vi } from "vitest";

import type { JsonValue } from "../json.js";
import { frameRefusal, refusalWords } from "./framing.js";

/** What the server says about a direction's page, from the next read on. */
const answering = (body: JsonValue, status = 200) =>
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("frameRefusal", () => {
  test("names the header that refused the frame, and anything short of that is no refusal", async () => {
    answering({ framable: false, refusal: { header: "x-frame-options", value: "DENY" } });
    expect(await frameRefusal("Docs")).toEqual({ header: "x-frame-options", value: "DENY" });

    answering({ framable: true });
    expect(await frameRefusal("Docs")).toBeNull();
    // Unknown: the page didn't answer, which the frame shows itself.
    answering({ framable: null });
    expect(await frameRefusal("Docs")).toBeNull();
    // A viewer is refused the route; an older server does not have it.
    answering({ error: "no" }, 403);
    expect(await frameRefusal("Docs")).toBeNull();
    answering({ framable: false, refusal: "DENY" });
    expect(await frameRefusal("Docs")).toBeNull();

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await frameRefusal("Docs")).toBeNull();
  });
});

describe("refusalWords", () => {
  const shell = "http://localhost:4100";

  const said = (words: { lead: string; quote: string; tail: string }) =>
    `${words.lead}${words.quote}${words.tail}`;

  test("says which site refused, why in the header's own words, and the header that would fix it", () => {
    const deny = refusalWords(
      { header: "x-frame-options", value: "DENY" },
      "https://docs.example.com/start",
      shell,
    );

    expect(deny.headline).toBe("docs.example.com won’t open inside another page");
    // The header's words are kept apart so they show as the site sent them.
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

    // The one header the site's owner could send.
    expect(deny.hint.quote).toBe("frame-ancestors http://localhost:4100");
    expect(said(deny.hint)).toBe(
      "If the site is yours, a Content-Security-Policy of frame-ancestors http://localhost:4100 lets it show here.",
    );
  });
});
