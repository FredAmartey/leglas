import { isJsonRecord, isString, type JsonValue } from "../json.js";

/**
 * A page that told the browser not to show it in a frame, and the header it
 * said it with.
 *
 * A preview with an absolute URL loads straight into its pane, and a refusal
 * there looks like nothing at all: the browser draws its own broken page and
 * fires the load event as if the page had arrived. The frame will not say
 * why, so the server asks the page and reads the headers the browser acted
 * on.
 */
export type FrameRefusal = {
  header: "x-frame-options" | "content-security-policy";
  value: string;
};

function isRefusal(value: JsonValue | undefined): value is FrameRefusal {
  return (
    isJsonRecord(value) &&
    (value.header === "x-frame-options" || value.header === "content-security-policy") &&
    isString(value.value)
  );
}

/**
 * The refusal behind a direction's page, or null when there is none to report.
 * Unknown counts as none: a page that did not answer is the frame's own story
 * to tell, and a viewer or an older server simply has no answer.
 */
export async function frameRefusal(
  title: string,
  fetcher: typeof fetch = fetch,
): Promise<FrameRefusal | null> {
  try {
    const response = await fetcher(
      `/leglas/api/previews/framing?title=${encodeURIComponent(title)}`,
    );

    if (!response.ok) return null;
    const payload: JsonValue = await response.json();

    return isJsonRecord(payload) && payload.framable === false && isRefusal(payload.refusal)
      ? { header: payload.refusal.header, value: payload.refusal.value }
      : null;
  } catch {
    return null;
  }
}

/** A sentence around some words the site itself sent, kept apart so they can be shown as sent. */
export type Quoted = { lead: string; quote: string; tail: string };

export type RefusalWords = { headline: string; reason: Quoted; hint: Quoted };

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
}

function because(refusal: FrameRefusal): Quoted {
  if (refusal.header === "content-security-policy") {
    return {
      lead: "Its Content-Security-Policy says ",
      quote: refusal.value,
      tail: ", and Leglas is not on that list.",
    };
  }

  const value = refusal.value.trim();
  const quote = `X-Frame-Options: ${value}`;

  switch (value.toLowerCase()) {
    case "deny":
      return {
        lead: "It sends ",
        quote,
        tail: ", which tells every browser not to show it in a frame.",
      };
    case "sameorigin":
      return { lead: "It sends ", quote, tail: ", which lets only its own pages frame it." };
    default:
      return { lead: "It sends ", quote, tail: ", which browsers read as a refusal." };
  }
}

/**
 * What the pane says about a refusal. The headline names the site, the reason
 * quotes the header, and the hint is the one change that would let it through:
 * a frame-ancestors directive outranks X-Frame-Options, so adding it is enough
 * whichever header refused.
 */
export function refusalWords(refusal: FrameRefusal, src: string, embedder: string): RefusalWords {
  return {
    headline: `${hostOf(src)} won’t open inside another page`,
    reason: because(refusal),
    hint: {
      lead: "If the site is yours, a Content-Security-Policy of ",
      quote: `frame-ancestors ${embedder}`,
      tail: " lets it show here.",
    },
  };
}
