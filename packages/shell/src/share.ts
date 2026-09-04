import { loadPrefs, railOrder, type Prefs } from "./prefs.js";
import type { Preview, ShareLayout, ShareScope } from "./types.js";

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
    request: { scope: "rail", titles: shared, layout: restrictedLayout(prefs, shared, null) },
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
