import { isBoolean, isJsonRecord, isNumber, isString, parseJson, type JsonValue } from "./json.js";
import type { Preview } from "./types.js";

export const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/** Rail width bounds. */
export const MIN_W = 274;

export const MAX_W = 395;

export const DEFAULT_W = 368;

export const VIEWPORTS = [
  { label: "Full", width: null },
  { label: "1440", width: 1440 },
  { label: "834", width: 834 },
  { label: "390", width: 390 },
] as const;

export type Prefs = {
  collapsed: boolean;
  /** Family roots whose variants are folded away in the rail. */
  collapsedFamilies: string[];
  /** Directions permanently cleared from this project's Leglas rail. */
  deleted: string[];
  /** Which corner the tools widget sits in; it is draggable between them. */
  corner: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** Interface typeface choice, validated by the shell against its options. */
  font: string;
  hidden: string[];
  /** Full order, hidden included; empty means config order. */
  order: string[];
  renames: Record<string, string>;
  /**
   * Show framework dev overlays inside previews. Badges like Next's sit over
   * the design and fight the tools widget for a corner, but they're the user's
   * app, and a preview that quietly differs from their dev server is the wrong
   * thing to judge. On by default.
   */
  showDevOverlays: boolean;
  /**
   * On by default: each side of a split is drawn at the stage's solo width and
   * scaled down, rather than given half the room to reflow. At half width a
   * layout crosses its breakpoints and the comparison becomes two narrow
   * renderings. Off is for inspecting that narrow state on purpose.
   */
  scaleSplit: boolean;
  /**
   * Let Leglas build a set of directions with Claude or Codex: the "+" in the
   * rail header, the brief in the composer and progress on rows. Off by default
   * while it's new.
   */
  buildDirections: boolean;
  /**
   * Show the tools widget over the stage. Off leaves the stage to the previews;
   * T reopens the tools, so it's never a trap.
   */
  showWidget: boolean;
  viewport: number | null;
  width: number;
};

export const DEFAULT_PREFS: Prefs = {
  buildDirections: false,
  collapsed: false,
  collapsedFamilies: [],
  deleted: [],
  corner: "bottom-right",
  font: "satoshi",
  hidden: [],
  order: [],
  renames: {},
  scaleSplit: true,
  showDevOverlays: true,
  showWidget: true,
  viewport: null,
  width: DEFAULT_W,
};

export function storageKey(project: string): string {
  return `leglas:${project}`;
}

/**
 * Prefs outlive config edits, so anything keyed by preview is filtered against
 * the live set on load and scalars are clamped. A malformed store falls back to
 * defaults: losing layout beats an interface that won't start.
 */
export function loadPrefs(raw: string | null, previews: readonly Preview[]): Prefs {
  const titles = previews.map((preview) => preview.title);

  try {
    if (!raw) return { ...DEFAULT_PREFS, order: titles };
    const saved = parseJson(raw);

    if (!isJsonRecord(saved)) return { ...DEFAULT_PREFS, order: titles };

    // A saved list holds titles; anything else goes with the titles that no
    // longer exist.
    const titlesIn = (value: JsonValue | undefined, among: readonly string[]): string[] =>
      Array.isArray(value) ? value.filter(isString).filter((title) => among.includes(title)) : [];

    const deleted = titlesIn(saved.deleted, titles);
    const available = titles.filter((title) => !deleted.includes(title));
    const kept = titlesIn(saved.order, available);

    const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
    const renames: Record<string, string> = {};

    if (isJsonRecord(saved.renames)) {
      for (const [title, name] of Object.entries(saved.renames)) {
        if (available.includes(title) && isString(name)) renames[title] = name;
      }
    }

    return {
      collapsed: Boolean(saved.collapsed),
      collapsedFamilies: titlesIn(saved.collapsedFamilies, available),
      // An unknown corner would leave the widget unpositioned, and it's the
      // only way into the tools.
      corner: CORNERS.find((corner) => corner === saved.corner) ?? DEFAULT_PREFS.corner,
      deleted,
      font: isString(saved.font) ? saved.font : DEFAULT_PREFS.font,
      hidden: titlesIn(saved.hidden, available),
      // Keep saved positions, append anything the config has added since.
      order: [...kept, ...available.filter((title) => !kept.includes(title))],
      renames,
      scaleSplit: isBoolean(saved.scaleSplit) ? saved.scaleSplit : DEFAULT_PREFS.scaleSplit,
      showDevOverlays: isBoolean(saved.showDevOverlays)
        ? saved.showDevOverlays
        : DEFAULT_PREFS.showDevOverlays,
      showWidget: isBoolean(saved.showWidget) ? saved.showWidget : DEFAULT_PREFS.showWidget,
      buildDirections: isBoolean(saved.buildDirections)
        ? saved.buildDirections
        : DEFAULT_PREFS.buildDirections,
      viewport:
        VIEWPORTS.map((viewport) => viewport.width).find((width) => width === saved.viewport) ??
        null,
      width:
        isNumber(saved.width) && Number.isFinite(saved.width)
          ? Math.round(Math.min(MAX_W, Math.max(MIN_W, saved.width)))
          : DEFAULT_W,
    };
  } catch {
    return { ...DEFAULT_PREFS, order: titles };
  }
}

/**
 * Permanently clears directions from the rail and every pref keyed by them. The
 * tombstone keeps a shared config direction from coming back on the next poll;
 * machine-local ones are also removed from the registry by the server.
 */
export function deleteDirections(prefs: Prefs, titles: readonly string[]): Prefs {
  const removed = new Set(titles);

  const renames = Object.fromEntries(
    Object.entries(prefs.renames).filter(([title]) => !removed.has(title)),
  );

  return {
    ...prefs,
    collapsedFamilies: prefs.collapsedFamilies.filter((title) => !removed.has(title)),
    deleted: [...new Set([...prefs.deleted, ...titles])],
    hidden: prefs.hidden.filter((title) => !removed.has(title)),
    order: prefs.order.filter((title) => !removed.has(title)),
    renames,
  };
}

/**
 * The rail's row order from the saved order and the previews that exist now.
 * Recomputed every render, since an agent can register previews mid-session:
 * saved order first minus titles that are gone, then unknown titles in config
 * order.
 */
export function railOrder(order: readonly string[], titles: readonly string[]): string[] {
  if (order.length === 0) return [...titles];
  const known = new Set(titles);
  const kept = order.filter((title) => known.has(title));
  const listed = new Set(kept);

  return [...kept, ...titles.filter((title) => !listed.has(title))];
}
