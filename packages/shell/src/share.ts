import { loadPrefs, railOrder, type Prefs } from "./prefs.js";
import type { Preview, ShareLayout, ShareReach, ShareScope } from "./types.js";

/**
 * What a share carries, worked out from the rail as the sharer sees it.
 *
 * A share is a manifest: which directions, in what order, under what names,
 * with which families folded and the pair on stage when there is one. This
 * module turns the sharer's preferences into that manifest and back, and
 * says which directions cannot go. It knows nothing about the network; the
 * panel and the server do that part.
 */
export type ShareRequest = {
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  reach: ShareReach;
  /** The seed for `listed`: what these directions already loaded here. */
  routes: string[];
};

/** The preference fields a share carries. The rest are the viewer's own. */
const LAYOUT_KEYS = ["order", "renames", "collapsedFamilies", "viewport"] as const;

/**
 * Why a direction cannot be shared, or null when it can.
 *
 * A branch preview runs in its own checkout on its own port, which is a
 * second origin the tunnel does not reach. Saying so beats quietly dropping
 * it from the share and letting the viewer wonder where it went.
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
    // Hidden directions are simply not sent, so nothing needs hiding on the
    // other side and the viewer never learns what was set aside.
    collapsedFamilies: prefs.collapsedFamilies.filter((title) => included.has(title)),
    compare,
    viewport: prefs.viewport,
  };
}

/**
 * The whole rail: every direction showing, in rail order, minus the ones that
 * cannot go. `leftOut` names those so the panel can say so.
 */
export function railShare(
  prefs: Prefs,
  previews: readonly Preview[],
  reach: ShareReach = "open",
  routes: readonly string[] = [],
): { request: ShareRequest; leftOut: string[] } {
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
 * What is on stage: the active direction, or the pair when the stage is
 * split. Null with the reason when one of them cannot go, because a
 * comparison with one side missing is not the comparison that was meant.
 */
export function stageShare(
  prefs: Prefs,
  previews: readonly Preview[],
  active: string,
  compare: string | null,
  reach: ShareReach = "open",
  routes: readonly string[] = [],
): { request: ShareRequest | null; reason: string | null } {
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));
  const titles = compare === null || compare === active ? [active] : [active, compare];
  if (active === "") return { request: null, reason: "Nothing is on stage yet" };
  for (const title of titles) {
    const reason = unshareableReason(byTitle.get(title));
    if (reason !== null) {
      return { request: null, reason: `${prefs.renames[title] ?? title} ${reason}` };
    }
  }
  const scope: ShareScope = titles.length === 2 ? "compare" : "direction";
  return {
    request: {
      scope,
      titles,
      layout: restrictedLayout(prefs, titles, scope === "compare" ? (compare as string) : null),
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
  // Reach changes what a viewer can reach, so it is part of what "the same
  // share" means. The route list is not: it grows as the sharer allows
  // things, and offering to push that back as an update would ask them to
  // confirm work they have already done.
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
    renamesX.every(([key, value], index) => key === renamesY[index]?.[0] && value === renamesY[index]?.[1])
  );
}

/**
 * The sharer's layout as the string `loadPrefs` reads, so a viewer's rail is
 * seeded through the same validation a saved one goes through: unknown
 * titles filtered, the viewport clamped to a preset.
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
 * A viewer's prefs after the sharer pushed a new layout: the layout's fields
 * as the sharer has them, everything else (the rail's width, the typeface,
 * the widget's corner) as the viewer left it. The same validation as the
 * first seeding, so an unknown title or an odd viewport is dropped the same
 * way.
 */
export function adoptLayout(current: Prefs, layout: ShareLayout, previews: readonly Preview[]): Prefs {
  const seeded = loadPrefs(viewerPrefsRaw(layout), previews);
  const next = { ...current };
  for (const key of LAYOUT_KEYS) (next as Record<string, unknown>)[key] = seeded[key];
  return next;
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
 * How many are on a link, said the way a person would.
 *
 * Sessions rather than people, deliberately. One browser holds one link at a
 * time, because two entry links on the same origin write the same cookie, so
 * a count is a fact about tabs and not about who is at them. Saying "people"
 * would be a guess the interface has no way to make.
 */
export function viewersLine(viewers: number): string {
  if (viewers === 0) return "nobody on it yet";
  if (viewers === 1) return "1 watching";
  return `${viewers} watching`;
}

/**
 * What the shared directions have already loaded in this browser.
 *
 * A list of routes cannot be written by hand: nobody can enumerate a
 * bundler's asset graph, and a wrong list breaks the app without saying so.
 * But the sharer has been looking at these directions, so their own browser
 * already knows. Previews are proxied through Leglas, so they are
 * same-origin and their timing entries are readable from here.
 *
 * Partial by nature: only the directions that have been on stage have
 * loaded anything, and a chunk that arrives on scroll has not. The share
 * turns the rest away and says what it turned away, which is where the list
 * grows from.
 */
export function observedRoutes(
  frames: Iterable<HTMLIFrameElement>,
  titles: readonly string[],
  /** Taken rather than read, so this stays pure and can be tested. */
  origin: string,
): string[] {
  const wanted = new Set(titles);
  const routes = new Set<string>();
  for (const frame of frames) {
    const title = frame.dataset["preview"];
    if (title === undefined || !wanted.has(title)) continue;
    let entries: PerformanceEntryList = [];
    try {
      entries = frame.contentWindow?.performance.getEntriesByType("resource") ?? [];
    } catch {
      // A cross-origin preview keeps its own timings, which is fine: a
      // branch direction is not in a share anyway.
      continue;
    }
    for (const entry of entries) {
      try {
        const { origin: entryOrigin, pathname } = new URL(entry.name);
        // Only what this server serves. A font from a CDN is the viewer's
        // browser talking to the CDN, and no business of the list.
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
 * The folder a refused path sits in, as a route that would take everything
 * beside it, or null when it sits at the root and there is no folder to
 * offer.
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
 * How long a link has, short enough to sit beside its name.
 *
 * Hours until it is close, then minutes, because "23h" is all anybody needs
 * during the day and "40m" is what they need at the end of it.
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
 * A share link short enough to read: the host, and the token cut down to a
 * hint that it is there. The full thing goes to the clipboard.
 */
export function shortLink(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/s\/.+$/, "/s/…")}`;
  } catch {
    return url;
  }
}
