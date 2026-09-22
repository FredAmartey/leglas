/**
 * Whether a page will let the interface show it in a frame.
 *
 * A preview with an absolute URL loads straight into the stage's iframe, and
 * a site that forbids framing does not fail the way anything else fails: the
 * browser draws its own "refused to connect" page, fires the frame's load
 * event as usual, and tells the page nothing. The shell cannot read a
 * cross-origin frame to find out. The server can ask the page itself and
 * read the two headers browsers act on, by the rules the HTML standard gives
 * them, so the pane can say what happened instead of showing a broken image.
 *
 * It is a reading of an anonymous request. A site that frames differently
 * once signed in will be read as it treats a stranger.
 */

export type FrameRefusal = {
  header: "x-frame-options" | "content-security-policy";
  /** The header's own words, as the site sent them. */
  value: string;
};

/** Framable, refused with the header that refused it, or unknown when the page did not answer. */
export type Framing =
  { framable: true } | { framable: false; refusal: FrameRefusal } | { framable: null };

/** Long enough for a slow site to answer, short enough that a pane never waits on it for long. */
export const FRAMING_TIMEOUT_MS = 4000;

type HeaderReader = { get(name: string): string | null };

const FRAME_ANCESTORS = "frame-ancestors";

/** Header values quoted back to the user are capped; a policy can run to kilobytes. */
const QUOTE_CAP = 160;

function quote(value: string): string {
  return value.length <= QUOTE_CAP ? value : `${value.slice(0, QUOTE_CAP - 1)}…`;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

function portOf(url: URL): string {
  return url.port === "" ? defaultPort(url.protocol) : url.port;
}

function schemeAdmits(scheme: string, url: URL): boolean {
  // A source naming http also admits https: the upgrade is always allowed.
  return url.protocol === scheme || (scheme === "http:" && url.protocol === "https:");
}

// An IPv6 host is written in brackets, which URL keeps in its hostname too.
const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|\[[0-9a-f:.]+\]|[^:/*[\]]+)(?::(\*|\d+))?(\/.*)?$/i;

/** One source expression from a frame-ancestors list, matched against the embedding page. */
function sourceAdmits(source: string, embedder: URL, target: URL): boolean {
  const lower = source.toLowerCase();

  if (lower === "'self'") return embedder.origin === target.origin;

  if (lower === "*") return embedder.protocol === "http:" || embedder.protocol === "https:";

  if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) return schemeAdmits(lower, embedder);

  // Other keywords ('unsafe-inline' and the like) say nothing about framing.
  if (lower.startsWith("'")) return false;

  const match = HOST_SOURCE.exec(lower);

  if (match === null) return false;
  const [, scheme, host = "", port, path] = match;

  const schemeOk =
    scheme === undefined
      ? // No scheme borrows the protected page's own, with the upgrade allowed.
        schemeAdmits(target.protocol, embedder)
      : schemeAdmits(`${scheme}:`, embedder);

  const hostname = embedder.hostname.toLowerCase();

  const hostOk =
    host === "*"
      ? true
      : host.startsWith("*.")
        ? hostname.endsWith(host.slice(1))
        : hostname === host;

  const portOk =
    port === "*"
      ? true
      : port === undefined
        ? portOf(embedder) === defaultPort(embedder.protocol)
        : portOf(embedder) === port;

  const pathOk =
    path === undefined || path === "/"
      ? true
      : path.endsWith("/")
        ? embedder.pathname.startsWith(path)
        : embedder.pathname === path;

  return schemeOk && hostOk && portOk && pathOk;
}

function listAdmits(list: string, embedder: URL, target: URL): boolean {
  const sources = list.split(/\s+/).filter((source) => source !== "");

  // An empty list, or 'none', lets nobody in.
  return sources.some((source) => sourceAdmits(source, embedder, target));
}

/** The source list of each enforced policy's frame-ancestors directive. */
function ancestorLists(csp: string | null): string[] {
  if (csp === null) return [];
  const lists: string[] = [];

  // One header can carry several policies, separated by commas, and a
  // browser enforces every one of them.
  for (const policy of csp.split(",")) {
    for (const directive of policy.split(";")) {
      const trimmed = directive.trim();
      const name = trimmed.split(/\s+/, 1)[0]?.toLowerCase();

      if (name === FRAME_ANCESTORS) lists.push(trimmed.slice(FRAME_ANCESTORS.length).trim());
    }
  }

  return lists;
}

/**
 * What a browser would decide about framing a page that answered with these
 * headers, when the page doing the framing is `embedder`.
 *
 * Follows the HTML standard's check: an enforced frame-ancestors directive
 * decides on its own and X-Frame-Options is then ignored; otherwise DENY
 * refuses, SAMEORIGIN refuses any other origin, conflicting values refuse, and
 * anything else, ALLOW-FROM included, is ignored.
 */
export function framingFor(headers: HeaderReader, target: string, embedder: string): Framing {
  const targetUrl = new URL(target);
  const embedderUrl = new URL(embedder);
  const lists = ancestorLists(headers.get("content-security-policy"));

  if (lists.length > 0) {
    const refusing = lists.find((list) => !listAdmits(list, embedderUrl, targetUrl));

    return refusing === undefined
      ? { framable: true }
      : {
          framable: false,
          refusal: {
            header: "content-security-policy",
            value: quote(`${FRAME_ANCESTORS} ${refusing}`.trim()),
          },
        };
  }

  const raw = headers.get("x-frame-options");

  if (raw === null) return { framable: true };

  const values = new Set(
    raw.split(",").flatMap((value) => {
      const normal = value.trim().toLowerCase();

      return normal === "" ? [] : [normal];
    }),
  );

  const refused = {
    framable: false,
    refusal: { header: "x-frame-options", value: quote(raw.trim()) },
  } as const;

  if (values.size > 1) {
    return values.has("deny") || values.has("sameorigin") || values.has("allowall")
      ? refused
      : { framable: true };
  }

  if (values.has("deny")) return refused;

  if (values.has("sameorigin")) {
    return embedderUrl.origin === targetUrl.origin ? { framable: true } : refused;
  }

  return { framable: true };
}

/**
 * Ask the page, and read its answer the way the browser will. Follows
 * redirects, because the frame does and the last answer is the one that
 * counts. A page that does not answer in time is unknown, never refused.
 */
export async function checkFraming(
  target: string,
  embedder: string,
  fetcher: typeof fetch = fetch,
): Promise<Framing> {
  try {
    const response = await fetcher(target, {
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(FRAMING_TIMEOUT_MS),
    });

    // Only the headers are wanted; the body can stay on the wire.
    void response.body?.cancel().catch(() => {});

    return framingFor(response.headers, response.url === "" ? target : response.url, embedder);
  } catch {
    return { framable: null };
  }
}
