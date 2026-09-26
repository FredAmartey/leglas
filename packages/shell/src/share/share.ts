import { loadPrefs, railOrder, type Prefs } from "../prefs.js";
import type { Preview, ShareLayout, ShareReach, ShareScope } from "../types.js";

/**
 * What a share carries, from the rail as the sharer sees it: which directions,
 * their order and names, folded families and the pair on stage. Turns
 * preferences into that manifest and back, and says which directions can't go.
 * No networking here.
 */
export type ShareRequest = {
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  reach: ShareReach;
  /** The seed for `listed`: what these directions already loaded here. */
  routes: string[];
};

/**
 * Why a direction can't be shared, or null. A branch preview runs on its own
 * port, a second origin the tunnel doesn't reach; saying so beats silently
 * dropping it.
 */
export function unshareableReason(preview: Preview | undefined): string | null {
  if (preview === undefined) return "is not on the rail";

  if (preview.branch !== undefined) return "runs on its own port and can't be shared yet";

  return null;
}

function restrictedLayout(
  prefs: Prefs,
  titles: readonly string[],
  compare: string | null,
): ShareLayout {
  const included = new Set(titles);

  return {
    order: [...titles],
    renames: Object.fromEntries(
      Object.entries(prefs.renames).filter(([title]) => included.has(title)),
    ),
    // Hidden directions aren't sent, so nothing needs hiding on the other side
    // and the viewer never learns what was left out.
    collapsedFamilies: prefs.collapsedFamilies.filter((title) => included.has(title)),
    compare,
    viewport: prefs.viewport,
  };
}

/**
 * The whole rail: every showing direction in rail order, minus those that can't
 * go, which `leftOut` names.
 */
export type RailShare = { request: ShareRequest; leftOut: string[] };

export function railShare(
  prefs: Prefs,
  previews: readonly Preview[],
  reach: ShareReach = "open",
  routes: readonly string[] = [],
): RailShare {
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));
  const gone = new Set([...prefs.deleted, ...prefs.hidden]);

  const titles = railOrder(
    prefs.order,
    previews.map((preview) => preview.title),
  ).filter((title) => !gone.has(title));

  const leftOut: string[] = [];
  const shared: string[] = [];

  for (const title of titles) {
    (unshareableReason(byTitle.get(title)) === null ? shared : leftOut).push(title);
  }

  return {
    request: {
      scope: "rail",
      titles: shared,
      layout: restrictedLayout(prefs, shared, null),
      reach,
      routes: [...routes],
    },
    leftOut,
  };
}

/**
 * What's on stage: the active direction, or the pair when split. Null with a
 * reason if either can't go, since half a comparison isn't the one meant.
 */
export type StageShare = { request: ShareRequest | null; reason: string | null };

export function stageShare(
  prefs: Prefs,
  previews: readonly Preview[],
  active: string,
  compare: string | null,
  reach: ShareReach = "open",
  routes: readonly string[] = [],
): StageShare {
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));
  const pair = compare === null || compare === active ? null : compare;
  const titles = pair === null ? [active] : [active, pair];

  if (active === "") return { request: null, reason: "Nothing is on stage yet" };

  for (const title of titles) {
    const reason = unshareableReason(byTitle.get(title));

    if (reason !== null) {
      return { request: null, reason: `${prefs.renames[title] ?? title} ${reason}` };
    }
  }

  const scope: ShareScope = pair === null ? "direction" : "compare";

  return {
    request: {
      scope,
      titles,
      layout: restrictedLayout(prefs, titles, pair),
      reach,
      routes: [...routes],
    },
    reason: null,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Whether two manifests would show a viewer the same thing. */
export function sameShare(a: ShareRequest, b: ShareRequest): boolean {
  if (a.scope !== b.scope || !sameList(a.titles, b.titles)) return false;

  // Reach is part of what makes two shares the same. The route list isn't: it
  // grows as the sharer allows things, and offering that back as an update
  // would ask them to confirm work already done.
  if (a.reach !== b.reach) return false;
  const x = a.layout;
  const y = b.layout;
  const renamesX = Object.entries(x.renames).toSorted();
  const renamesY = Object.entries(y.renames).toSorted();

  return (
    sameList(x.order, y.order) &&
    sameList([...x.collapsedFamilies].toSorted(), [...y.collapsedFamilies].toSorted()) &&
    x.compare === y.compare &&
    x.viewport === y.viewport &&
    renamesX.length === renamesY.length &&
    renamesX.every(
      ([key, value], index) => key === renamesY[index]?.[0] && value === renamesY[index]?.[1],
    )
  );
}

/**
 * The sharer's layout as the string `loadPrefs` reads, so a viewer's rail goes
 * through the same validation a saved one does.
 */
export function viewerPrefsRaw(layout: ShareLayout): string {
  return JSON.stringify({
    collapsedFamilies: layout.collapsedFamilies,
    order: layout.order,
    renames: layout.renames,
    viewport: layout.viewport,
  });
}

/**
 * A viewer's prefs after the sharer pushed a layout: layout fields from the
 * sharer, everything else (rail width, typeface, widget corner) as the viewer
 * left it, with the same validation as the first seeding.
 */
export function adoptLayout(
  current: Prefs,
  layout: ShareLayout,
  previews: readonly Preview[],
): Prefs {
  const seeded = loadPrefs(viewerPrefsRaw(layout), previews);

  // The fields a share carries, and only those; the rest are the viewer's own.
  return {
    ...current,
    collapsedFamilies: seeded.collapsedFamilies,
    order: seeded.order,
    renames: seeded.renames,
    viewport: seeded.viewport,
  };
}

/** What is being shared, in a few words, for the panel and the tip. */
export function scopeLine(
  scope: ShareScope,
  titles: readonly string[],
  displayName: (title: string) => string,
): string {
  if (scope === "rail") {
    return `The whole rail · ${titles.length} direction${titles.length === 1 ? "" : "s"}`;
  }

  return titles.map(displayName).join(" + ");
}

/**
 * How many are on a link. Sessions, not people: one browser holds one link at a
 * time (two entry links on one origin write the same cookie), so the count is
 * about tabs.
 */
export function viewersLine(viewers: number): string {
  if (viewers === 0) return "nobody on it yet";

  if (viewers === 1) return "1 watching";

  return `${viewers} watching`;
}

/** What `observedRoutes` reads of a frame, so a test can hand it one it made. */
export type RouteFrame = {
  dataset: { preview?: string | undefined };
  contentWindow: {
    performance: { getEntriesByType(type: string): readonly { name: string }[] };
  } | null;
};

/**
 * What the shared directions already loaded in this browser. Nobody can list a
 * bundler's asset graph by hand, but the sharer's browser has loaded these
 * directions through Leglas, so their same-origin timing entries are readable.
 * Partial: only directions that were on stage count, and scroll-loaded chunks
 * are missing. The share reports what it refuses, which is how the list grows.
 */
export function observedRoutes(
  frames: Iterable<RouteFrame>,
  titles: readonly string[],
  /** Passed in rather than read, so this stays pure. */
  origin: string,
): string[] {
  const wanted = new Set(titles);
  const routes = new Set<string>();

  for (const frame of frames) {
    const title = frame.dataset["preview"];

    if (title === undefined || !wanted.has(title)) continue;
    let entries: readonly { name: string }[] = [];

    try {
      entries = frame.contentWindow?.performance.getEntriesByType("resource") ?? [];
    } catch {
      // A cross-origin preview keeps its timings to itself; branch directions
      // aren't in shares anyway.
      continue;
    }

    for (const entry of entries) {
      try {
        const { origin: entryOrigin, pathname } = new URL(entry.name);

        // Only what this server serves; a CDN font is between the viewer and
        // the CDN.
        if (entryOrigin !== origin) continue;
        routes.add(pathname);
      } catch {
        // Not a URL this can read; nothing to list.
      }
    }
  }

  return [...routes].toSorted();
}

/**
 * The folder a refused path is in, as a route covering everything beside it, or
 * null at the root.
 */
export function directoryOf(path: string): string | null {
  const cut = path.lastIndexOf("/");

  if (cut <= 0) return null;

  return path.slice(0, cut + 1);
}

/** Everyone watching, across every link into the share. */
export function totalViewers(grants: readonly { viewers: number }[]): number {
  return grants.reduce((count, grant) => count + grant.viewers, 0);
}

/**
 * How long a link has, short enough to sit beside its name: hours until it's
 * close, then minutes.
 */
export function expiryLine(expiresAt: number, now: number): string {
  const left = expiresAt - now;

  if (left <= 0) return "expired";
  const minutes = Math.round(left / 60_000);

  if (minutes < 60) return `${Math.max(1, minutes)}m left`;
  const hours = Math.round(left / 3_600_000);

  return `${hours}h left`;
}

/** A link with nothing typed against it still needs calling something. */
export function grantLabel(name: string, index: number): string {
  return name.trim() === "" ? `Link ${index + 1}` : name;
}

/**
 * A share link short enough to read: the host and a hint of the token. The full
 * link goes to the clipboard.
 */
export function shortLink(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.host}${parsed.pathname.replace(/\/s\/.+$/, "/s/…")}`;
  } catch {
    return url;
  }
}
