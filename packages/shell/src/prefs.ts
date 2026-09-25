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
   * Show framework dev overlays inside previews. Next and others paint their
   * own floating badge over the app, which lands on top of the design being
   * judged and fights the tools widget for the same corner. On by default:
   * the badge belongs to the user's app, and a preview that quietly differs
   * from what their dev server renders is the wrong thing to judge against.
   */
  showDevOverlays: boolean;
  /**
   * Draw each side of a split at the width the stage has on its own and scale
   * it down to fit, rather than handing it half the room and letting it
   * reflow. On by default, because the alternative silently changes the design
   * being judged: at half width a layout crosses its own breakpoints, and the
   * comparison becomes two narrow renderings of directions meant for the wide
   * one. Turning it off is for deliberately inspecting that narrow state.
   */
  scaleSplit: boolean;
  /**
   * Let Leglas build a set of directions itself, with Claude or Codex: the "+" in the
   * rail's header, the brief in the composer and each direction's progress
   * on its row. Off by default while the feature is new, so switching it off
   * takes every part of it away again.
   */
  buildDirections: boolean;
  /**
   * Show the tools widget over the stage. Turning it off leaves the stage to
   * the previews alone; T reopens the tools, so the switch is never a trap.
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
 * Prefs outlive edits to the config, so anything keyed by preview is filtered
 * against the live set on load and scalar layout values are clamped back into
 * their legal ranges. A malformed or unreadable store falls back to defaults
 * rather than throwing: losing saved layout is a smaller failure than an
 * interface that will not start.
 */
export function loadPrefs(raw: string | null, previews: readonly Preview[]): Prefs {
  const titles = previews.map((preview) => preview.title);

  try {
    if (!raw) return { ...DEFAULT_PREFS, order: titles };
    const saved = parseJson(raw);

    if (!isJsonRecord(saved)) return { ...DEFAULT_PREFS, order: titles };

    // A saved list holds titles; anything else in it is dropped with the
    // titles that no longer exist.
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
      // An unrecognised corner would leave the widget unpositioned, and it is
      // the only way into the tools.
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
 * Permanently clear directions from the rail and every preference keyed by
 * them. The tombstone keeps a shared config direction from reappearing on the
 * next poll, while machine-local directions are also removed from Leglas's
 * registry by the server.
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
 * The rail's row order, from saved order and the previews that exist now.
 *
 * Saved order used to be reconciled with the config once, at load. Previews
 * can appear mid-session now, registered by an agent while the interface is
 * open, and a saved order that predates them would leave their rows invisible.
 * So the reconciliation happens every render: saved order first, minus titles
 * that no longer exist, with unknown titles appended in config order.
 */
export function railOrder(order: readonly string[], titles: readonly string[]): string[] {
  if (order.length === 0) return [...titles];
  const known = new Set(titles);
  const kept = order.filter((title) => known.has(title));
  const listed = new Set(kept);

  return [...kept, ...titles.filter((title) => !listed.has(title))];
}
