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
   * Show the tools widget over the stage. Turning it off leaves the stage to
   * the previews alone; T reopens the tools, so the switch is never a trap.
   */
  showWidget: boolean;
  viewport: number | null;
  width: number;
};

export const DEFAULT_PREFS: Prefs = {
  collapsed: false,
  collapsedFamilies: [],
  corner: "bottom-right",
  font: "satoshi",
  hidden: [],
  order: [],
  renames: {},
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
    const saved = JSON.parse(raw) as Partial<Prefs>;
    const parsed = { ...DEFAULT_PREFS, ...saved };
    const kept = (Array.isArray(parsed.order) ? parsed.order : []).filter((title) =>
      titles.includes(title),
    );
    const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;
    return {
      collapsed: Boolean(parsed.collapsed),
      collapsedFamilies: (Array.isArray(parsed.collapsedFamilies)
        ? parsed.collapsedFamilies
        : []
      ).filter((title) => titles.includes(title)),
      // An unrecognised corner would leave the widget unpositioned, and it is
      // the only way into the tools.
      corner: CORNERS.includes(parsed.corner as (typeof CORNERS)[number])
        ? (parsed.corner as Prefs["corner"])
        : DEFAULT_PREFS.corner,
      font: typeof parsed.font === "string" ? parsed.font : DEFAULT_PREFS.font,
      hidden: (Array.isArray(parsed.hidden) ? parsed.hidden : []).filter((title) =>
        titles.includes(title),
      ),
      // Keep saved positions, append anything the config has added since.
      order: [...kept, ...titles.filter((title) => !kept.includes(title))],
      renames: Object.fromEntries(
        Object.entries(parsed.renames ?? {}).filter(([title]) => titles.includes(title)),
      ),
      showDevOverlays:
        typeof saved.showDevOverlays === "boolean"
          ? saved.showDevOverlays
          : DEFAULT_PREFS.showDevOverlays,
      showWidget:
        typeof saved.showWidget === "boolean" ? saved.showWidget : DEFAULT_PREFS.showWidget,
      viewport: VIEWPORTS.some((viewport) => viewport.width === parsed.viewport)
        ? parsed.viewport
        : null,
      width: Number.isFinite(parsed.width)
        ? Math.round(Math.min(MAX_W, Math.max(MIN_W, parsed.width)))
        : DEFAULT_W,
    };
  } catch {
    return { ...DEFAULT_PREFS, order: titles };
  }
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

/** Reorder `title` to sit at `toIndex` among the visible rows. */
export function reorder(prefs: Prefs, previews: readonly Preview[], title: string, toIndex: number): string[] {
  const titles = previews.map((preview) => preview.title);
  const order = (prefs.order.length ? prefs.order : titles).filter((entry) => entry !== title);
  const visible = order.filter((entry) => !prefs.hidden.includes(entry));
  const before = visible[toIndex];
  const insertAt = before === undefined ? order.length : order.indexOf(before);
  order.splice(insertAt, 0, title);
  return order;
}
