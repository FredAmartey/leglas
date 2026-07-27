import type { Preview } from "./config.js";

export type Fetcher = (url: string) => Promise<string>;

/**
 * Chunk on tag boundaries as well as newlines. Frameworks emit one enormous
 * line, so splitting on newlines alone would compare two indivisible blobs
 * and conclude that every page is unique.
 */
function chunks(body: string): string[] {
  return body
    .split(/[\n<]/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "");
}

/**
 * What two renders of the same URL agree on.
 *
 * Frameworks stamp each response with per-request noise: on the app this was
 * built against, two fetches of one URL differ by exactly 21 characters, a
 * random router id. Fetching twice and keeping only the chunks both renders
 * share strips that noise without needing to know which framework produced it.
 */
export function stableSignature(first: string, second: string): string {
  const shared = new Set(chunks(second));
  return chunks(first)
    .filter((chunk) => shared.has(chunk))
    .join("\n");
}

/**
 * Remove the preview's own address from the page.
 *
 * Frameworks echo the request URL into their payload, so a typo'd preview
 * never matches byte-for-byte even when it renders the identical page. The
 * echo is an artefact of the request, never a design difference.
 */
/**
 * Keep the rendered markup, drop script bodies.
 *
 * Frameworks serialise the request into their hydration payload, and in
 * whatever encoding they please: the app this was built against writes the
 * search params as `__PAGE__?{\"v-hero\":\"wavee\"}`, so stripping the literal
 * query string does not match it. Chasing encodings is a losing game.
 *
 * Comparing only what was rendered is the better rule anyway. Two previews
 * are the same when they draw the same page; a hydration payload is
 * implementation detail, not something the user is comparing.
 */
function renderedOnly(body: string): string {
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "<script/>");
}

/**
 * Below this, a response is a shell rather than a page.
 *
 * A single-page app serves one near-empty document for every URL and resolves
 * the direction in the browser, so every signature is identical no matter how
 * different the directions look on screen. The comparison cannot see what the
 * user sees, so it must not claim to.
 */
const MEANINGFUL_CHUNKS = 20;

/**
 * Group previews that render the same page.
 *
 * This exists because a declared URL can silently lie: `?v-hero=wavee` is a
 * typo the app ignores, so it serves the default and the user compares two
 * identical pages without noticing. Surfacing it is the difference between a
 * tool that shows the truth and one that quietly agrees with a mistake.
 *
 * Only relative URLs are checked; an absolute one points somewhere Leglas
 * does not proxy, so its body is not ours to reason about. A preview that
 * cannot be fetched is skipped rather than failing the whole check: a warning
 * is a courtesy, and a courtesy should never break the tool.
 */
export async function findDuplicates(
  previews: readonly Preview[],
  fetch: Fetcher,
): Promise<string[][]> {
  const signatures = new Map<string, string[]>();

  for (const preview of previews) {
    if (!preview.url.startsWith("/")) continue;
    try {
      const [first, second] = await Promise.all([fetch(preview.url), fetch(preview.url)]);
      const signature = stableSignature(renderedOnly(first), renderedOnly(second));
      if (signature === "") continue;
      // The server rendered a shell, so it has nothing to say about which
      // direction this is. Reporting anything here would be a confident lie.
      if (signature.split("\n").length < MEANINGFUL_CHUNKS) continue;
      const group = signatures.get(signature);
      if (group) group.push(preview.title);
      else signatures.set(signature, [preview.title]);
    } catch {
      // Unreachable preview: the pane's own error state already reports it.
    }
  }

  return [...signatures.values()].filter((group) => group.length > 1);
}
