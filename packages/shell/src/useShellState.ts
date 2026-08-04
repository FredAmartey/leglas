import { useEffect, useRef, useState } from "react";

import {
  MAX_W,
  MIN_W,
  VIEWPORTS,
  loadPrefs,
  railOrder,
  reorder,
  storageKey,
  type Prefs,
} from "./prefs.js";
import { collapseRows, familyRows, rootOf } from "./families.js";
import { resolveKey } from "./keymap.js";
import type { Preview } from "./types.js";

/**
 * The engine every shell body sits on: prefs, selection, search, rename and
 * remove, copy, keyboard, resize, and pane mounting. Bodies own how it looks;
 * this owns how it behaves. That split is what lets the interface be explored
 * as a design surface without reimplementing its mechanics.
 *
 * Panes mount lazily on first activation and stay mounted after, so flips are
 * instant without paying for every direction upfront. Nested inside another
 * preview, only the active pane mounts, or self-hosting multiplies iframes.
 */
export type ShellStateProps = {
  previews: readonly Preview[];
  project: string;
  /** Owned by the body; this only focuses it. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Invoked by the compare shortcut; the split itself lives in the shell. */
  onToggleSplit?: (() => void) | undefined;
  /** Invoked by the help shortcut; the overlay lives in the shell. */
  onToggleHelp?: (() => void) | undefined;
  /**
   * Hold every shortcut but help, for when something on top owns the keyboard.
   */
  suspended?: boolean | undefined;
};

export function useShellState({
  previews,
  project,
  searchRef,
  onToggleSplit,
  onToggleHelp,
  suspended = false,
}: ShellStateProps) {
  const key = storageKey(project);
  const initial = () =>
    loadPrefs(typeof window === "undefined" ? null : window.localStorage.getItem(key), previews);

  const [prefs, setPrefs] = useState<Prefs>(initial);
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));

  const firstVisible = () => {
    const saved = initial();
    const ordered = saved.order.length ? saved.order : previews.map((preview) => preview.title);
    return ordered.find((title) => !saved.hidden.includes(title)) ?? ordered[0] ?? "";
  };

  const [active, setActiveRaw] = useState<string>(firstVisible);
  const nested = typeof window !== "undefined" && window.self !== window.top;
  const [mounted, setMounted] = useState<readonly string[]>(() => [firstVisible()]);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setActive = (title: string) => {
    setActiveRaw(title);
    setMounted((current) => (current.includes(title) ? current : [...current, title]));
  };

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  }, [prefs, key]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const displayName = (title: string) => prefs.renames[title] ?? title;
  const urlFor = (title: string) => byTitle.get(title)?.url ?? "/";

  const matches = (title: string) => {
    if (!query.trim()) return true;
    const needle = query.toLowerCase();
    const preview = byTitle.get(title);
    return (
      displayName(title).toLowerCase().includes(needle) ||
      title.toLowerCase().includes(needle) ||
      (preview?.note ?? "").toLowerCase().includes(needle) ||
      (preview?.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
    );
  };

  const titles = previews.map((preview) => preview.title);
  // Derived every render rather than reconciled once at load, so previews an
  // agent registers mid-session get rows the moment they arrive.
  const ordered = railOrder(prefs.order, titles);

  // Family structure: shades sit under the direction they are based on, and a
  // collapsed family folds its shades away. Search overrides collapse, since
  // a query that matches a folded shade must be able to reveal it. Computed
  // from the visible titles, so hiding a direction promotes its shades to
  // roots instead of stranding them.
  const basedOnMap = new Map(
    previews.flatMap((preview) =>
      preview.basedOn === undefined ? [] : [[preview.title, preview.basedOn] as const],
    ),
  );
  const grouped = familyRows(
    ordered.filter((title) => !prefs.hidden.includes(title) && matches(title)),
    basedOnMap,
  );
  const rowsWithDepth = collapseRows(
    grouped,
    new Set(prefs.collapsedFamilies),
    query.trim() !== "",
  );
  const rows = rowsWithDepth.map((row) => row.title);
  /** Per-title rail metadata: indent depth, shade count, folded state. */
  const rowMeta = new Map(
    rowsWithDepth.map((row) => {
      const shades =
        row.depth === 0 ? grouped.filter((entry) => entry.depth === 1 && rootOf(entry.title, basedOnMap) === row.title).length : 0;
      return [
        row.title,
        { depth: row.depth, shades, folded: prefs.collapsedFamilies.includes(row.title) },
      ] as const;
    }),
  );
  const toggleFamily = (title: string) =>
    setPrefs((current) => ({
      ...current,
      collapsedFamilies: current.collapsedFamilies.includes(title)
        ? current.collapsedFamilies.filter((entry) => entry !== title)
        : [...current.collapsedFamilies, title],
    }));
  /** The direction a shade is based on, for its default comparison. */
  const parentOf = (title: string) => byTitle.get(title)?.basedOn ?? null;

  /** Rows that would show if the search were cleared, for the empty state. */
  const visibleCount = ordered.filter((title) => !prefs.hidden.includes(title)).length;

  const moveOption = (title: string, toIndex: number) =>
    setPrefs((current) => ({ ...current, order: reorder(current, previews, title, toIndex) }));

  const hide = (title: string) => {
    setPrefs((current) => ({ ...current, hidden: [...current.hidden, title] }));
    if (active !== title) return;
    const next = ordered.find((entry) => entry !== title && !prefs.hidden.includes(entry));
    if (next) setActive(next);
  };

  const rename = (title: string, value: string) => {
    setPrefs((current) => {
      const renames = { ...current.renames };
      if (!value || value === title) delete renames[title];
      else renames[title] = value;
      return { ...current, renames };
    });
    setRenaming(null);
  };

  // Which key does what lives in keymap.ts; this only carries the actions out.
  useEffect(() => {
    const cycle = rows;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Read the tag rather than instanceof: a target inside a preview comes
      // from that frame's realm, where the parent's HTMLInputElement never
      // matches, and every keystroke typed into the app would look like a
      // shortcut.
      const tag = target?.tagName?.toLowerCase();
      const action = resolveKey({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        typing:
          tag === "input" ||
          tag === "textarea" ||
          tag === "select" ||
          (target?.isContentEditable ?? false),
      });
      if (!action) return;
      if (suspended && action.kind !== "help") return;

      if (action.kind === "search") {
        event.preventDefault();
        setPrefs((current) => (current.collapsed ? { ...current, collapsed: false } : current));
        searchRef.current?.focus();
      } else if (action.kind === "split") {
        event.preventDefault();
        onToggleSplit?.();
      } else if (action.kind === "help") {
        event.preventDefault();
        onToggleHelp?.();
      } else if (action.kind === "rail") {
        setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
      } else if (action.kind === "jump") {
        // Past the end is a miss rather than the last direction: the digit
        // names a slot, and a slot that is not there has no sensible stand-in.
        const next = cycle[action.index];
        if (next) {
          event.preventDefault();
          setActive(next);
        }
      } else if (action.kind === "move") {
        event.preventDefault();
        const index = cycle.indexOf(active);
        const next =
          action.delta === 1
            ? cycle[Math.min(cycle.length - 1, index + 1)]
            : cycle[Math.max(0, index - 1)];
        if (next) setActive(next);
      }
    };
    /**
     * Clicking a design moves focus into its frame, and a keydown there never
     * reaches this window, so the shortcuts went dead until something pulled
     * focus back out. Listening on each same-origin preview as well keeps them
     * alive while a design has focus, which is most of the time. A cross-origin
     * preview cannot be reached and keeps its own keyboard.
     */
    const targets: (Document | Window)[] = [window];
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const doc = frame.contentDocument;
        if (doc) targets.push(doc);
      } catch {
        // Cross-origin: not ours to listen on.
      }
    }
    for (const target of targets) target.addEventListener("keydown", onKey as EventListener);
    return () => {
      for (const target of targets) target.removeEventListener("keydown", onKey as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    rows.join("|"),
    onToggleSplit,
    onToggleHelp,
    suspended,
    // Re-attach as previews mount and as each one finishes loading, since a
    // fresh document does not inherit the old one's listener.
    mounted.join("|"),
    Object.entries(loaded)
      .filter(([, done]) => done)
      .map(([title]) => title)
      .join("|"),
  ]);

  const copyReference = (title: string) => {
    const url = `${window.location.origin}${urlFor(title)}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(title);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1200);
    });
  };

  // Pointer capture keeps every move routed to the handle, even over the
  // preview iframe, which is a separate document that swallows pointer events.
  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = prefs.width;
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const width = Math.min(MAX_W, Math.max(MIN_W, startWidth + moveEvent.clientX - startX));
      setPrefs((current) => (current.width === width ? current : { ...current, width }));
    };
    const stop = (upEvent: PointerEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setResizing(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const markLoaded = (title: string) =>
    setLoaded((current) => (current[title] ? current : { ...current, [title]: true }));

  /** Drop a pane's loaded flag so its skeleton shows again on a forced reload. */
  const resetLoaded = (title: string) =>
    setLoaded((current) => (current[title] ? { ...current, [title]: false } : current));

  const panes = nested ? [active] : titles.filter((title) => mounted.includes(title));

  return {
    active,
    copied,
    copyReference,
    displayName,
    hiddenCount: prefs.hidden.length,
    hide,
    loaded,
    markLoaded,
    matches,
    moveOption,
    nested,
    onHandlePointerDown,
    panes,
    prefs,
    previewFor: (title: string) => byTitle.get(title),
    query,
    rename,
    renaming,
    parentOf,
    resetLoaded,
    resizing,
    rowMeta,
    rows,
    toggleFamily,
    setActive,
    setPrefs,
    setQuery,
    setRenaming,
    setShowHidden,
    showHidden,
    urlFor,
    visibleCount,
    viewports: VIEWPORTS,
  };
}

export type ShellState = ReturnType<typeof useShellState>;
