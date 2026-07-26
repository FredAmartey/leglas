import { useEffect, useRef, useState } from "react";

import { MAX_W, MIN_W, VIEWPORTS, loadPrefs, reorder, storageKey, type Prefs } from "./prefs.js";
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
};

export function useShellState({ previews, project, searchRef }: ShellStateProps) {
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
  const ordered = prefs.order.length ? prefs.order : titles;
  const rows = ordered.filter((title) => !prefs.hidden.includes(title) && matches(title));
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

  // ↑↓ cycle rows, / focuses search, [ toggles the rail.
  useEffect(() => {
    const cycle = rows;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        setPrefs((current) => (current.collapsed ? { ...current, collapsed: false } : current));
        searchRef.current?.focus();
      } else if (event.key === "[") {
        setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = cycle.indexOf(active);
        const next =
          event.key === "ArrowDown"
            ? cycle[Math.min(cycle.length - 1, index + 1)]
            : cycle[Math.max(0, index - 1)];
        if (next) setActive(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows.join("|")]);

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
    resetLoaded,
    resizing,
    rows,
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
