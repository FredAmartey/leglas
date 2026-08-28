import { useEffect, useRef, useState } from "react";

import {
  MAX_W,
  MIN_W,
  VIEWPORTS,
  deleteDirections,
  loadPrefs,
  railOrder,
  reorder,
  storageKey,
  type Prefs,
} from "./prefs.js";
import { collapseRows, familyRows, rootOf } from "./families.js";
import { copyText } from "./clipboard.js";
import { resolveKey } from "./keymap.js";
import { checkName } from "./naming.js";
import { absoluteUrl, referenceText } from "./reference.js";
import {
  markPreviewLoaded,
  previewIsLoaded,
  resetPreviewLoaded,
} from "./preview-frame.js";
import { dismissToast, pushToast, TOAST_TTL, type Toast } from "./toasts.js";
import type { BranchPreviewState, Preview } from "./types.js";

/**
 * The engine every shell body sits on: prefs, selection, search, rename and
 * remove, copy, keyboard, resize, and pane mounting. Bodies own how it looks;
 * this owns how it behaves. That split is what lets the interface be explored
 * as a design surface without reimplementing its mechanics.
 *
 * Anything that changes the list also reports what it did. Copy, rename and
 * remove each end in a toast naming the direction they touched, and the two
 * that can be taken back carry their own undo, so nothing here is a change you
 * have to squint at the rail to confirm.
 *
 * Pane history is recorded lazily on activation. A shell body decides whether
 * to retain that history or mount only what is visible; nested shells expose
 * only the active pane so self-hosting never multiplies iframes.
 */
/** The link on its own, or the block that says what the direction is. */
export type CopyKind = "link" | "reference";

export type ShellStateProps = {
  previews: readonly Preview[];
  project: string;
  /** Owned by the body; this only focuses it. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Invoked by the compare shortcut; the split itself lives in the shell. */
  onToggleSplit?: (() => void) | undefined;
  /** Invoked by the help shortcut; the overlay lives in the shell. */
  onToggleHelp?: (() => void) | undefined;
  /** Invoked by the tools shortcut; the widget and popover live in the shell. */
  onToggleTools?: (() => void) | undefined;
  onToggleNote?: (() => void) | undefined;
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
  onToggleTools,
  onToggleNote,
  suspended = false,
}: ShellStateProps) {
  const key = storageKey(project);
  const initial = () =>
    loadPrefs(typeof window === "undefined" ? null : window.localStorage.getItem(key), previews);

  const [prefs, setPrefs] = useState<Prefs>(initial);
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));

  const firstVisible = () => {
    const saved = initial();
    return (
      saved.order.find((title) => !saved.hidden.includes(title)) ?? saved.order[0] ?? ""
    );
  };

  const [active, setActiveRaw] = useState<string>(firstVisible);
  const nested = typeof window !== "undefined" && window.self !== window.top;
  const [mounted, setMounted] = useState<readonly string[]>(() => [firstVisible()]);
  const [query, setQueryRaw] = useState("");
  /**
   * Folds made while a search is active, scoped to that search. Starting
   * empty is what lets a fresh query reveal variants their family had folded
   * away, and folding here leaves the saved preference alone: putting rows
   * away while looking for something is a viewing gesture, not a decision
   * about the rail.
   */
  const [searchFolded, setSearchFolded] = useState<readonly string[]>([]);
  const setQuery = (value: string) => {
    // A new query is a new search; folds made against the old one are stale.
    setSearchFolded((current) => (current.length ? [] : current));
    setQueryRaw(value);
  };
  const [showHidden, setShowHidden] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Why the open rename form refused what was typed into it. */
  const [renameError, setRenameError] = useState<string | null>(null);
  /** Which control just copied, so the tick lands on that one and not its twin. */
  const [copied, setCopied] = useState<{ kind: CopyKind; title: string } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  /**
   * A field the keyboard has asked for, which the shell focuses once the rail
   * it lives in has rendered. The nonce is what makes pressing the same key
   * twice in a row a second request rather than a no-op.
   */
  const [focusing, setFocusing] = useState<{ target: "request" | "search"; nonce: number } | null>(
    null,
  );
  const focusNonce = useRef(1);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToast = useRef(0);

  const notify = (toast: Omit<Toast, "id">) => {
    lastToast.current += 1;
    setToasts((current) => pushToast(current, { ...toast, id: lastToast.current }));
  };
  const dismiss = (id: number) => setToasts((current) => dismissToast(current, id));

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

  /**
   * A branch preview's checkout state, or null when the preview is a route on
   * the running app and so has nothing to start.
   */
  const branchState = (title: string): BranchPreviewState | null => {
    const preview = byTitle.get(title);
    return preview?.branch === undefined ? null : (preview.state ?? { status: "idle" });
  };

  /**
   * Ask the server to bring a branch up. Safe to call again: the server joins
   * a start already in flight rather than checking out twice, so opening a
   * preview twice while it boots is one checkout, and a failed one retries.
   * The interface hears the result through the live socket's config nudge.
   */
  const startBranch = (title: string) => {
    void fetch("/leglas/api/previews/start", {
      body: JSON.stringify({ title }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => {});
  };

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

  const titles = previews
    .map((preview) => preview.title)
    .filter((title) => !prefs.deleted.includes(title));
  // Derived every render rather than reconciled once at load, so previews an
  // agent registers mid-session get rows the moment they arrive.
  const ordered = railOrder(prefs.order, titles);

  // Family structure: variants sit under the direction they are based on, and a
  // collapsed family folds its variants away. While a search is active the
  // saved folds step aside for the per-search set, so a query that matches a
  // folded variant reveals it and the fold control keeps working against what
  // is on screen. Computed from the visible titles, so hiding a direction
  // promotes its variants to roots instead of stranding them.
  const searching = query.trim() !== "";
  const foldedNow = searching ? searchFolded : prefs.collapsedFamilies;
  const basedOnMap = new Map(
    previews.flatMap((preview) =>
      preview.basedOn === undefined ? [] : [[preview.title, preview.basedOn] as const],
    ),
  );
  const grouped = familyRows(
    ordered.filter((title) => !prefs.hidden.includes(title) && matches(title)),
    basedOnMap,
  );
  const rowsWithDepth = collapseRows(grouped, new Set(foldedNow));
  const rows = rowsWithDepth.map((row) => row.title);
  /** Per-title rail metadata: indent depth, variant count, folded state. */
  const rowMeta = new Map(
    rowsWithDepth.map((row) => {
      const variants =
        row.depth === 0 ? grouped.filter((entry) => entry.depth === 1 && rootOf(entry.title, basedOnMap) === row.title).length : 0;
      return [
        row.title,
        { depth: row.depth, variants, folded: foldedNow.includes(row.title) },
      ] as const;
    }),
  );
  const toggleIn = (list: readonly string[], title: string) =>
    list.includes(title) ? list.filter((entry) => entry !== title) : [...list, title];
  const toggleFamily = (title: string) =>
    searching
      ? setSearchFolded((current) => toggleIn(current, title))
      : setPrefs((current) => ({
          ...current,
          collapsedFamilies: toggleIn(current.collapsedFamilies, title),
        }));
  /** The direction a variant is based on, for its default comparison. */
  const parentOf = (title: string) => byTitle.get(title)?.basedOn ?? null;

  /** Rows that would show if the search were cleared, for the empty state. */
  const visibleCount = ordered.filter((title) => !prefs.hidden.includes(title)).length;

  const moveOption = (title: string, toIndex: number) =>
    setPrefs((current) => ({ ...current, order: reorder(current, previews, title, toIndex) }));

  /**
   * Put a removed direction back. Order is untouched by removal, so it returns
   * to its own slot rather than the end, and undoing the removal of whatever
   * was on stage puts it back on stage: a restore that leaves you looking at
   * something else has only half undone the thing.
   */
  const restore = (title: string, select = false) => {
    setPrefs((current) => ({
      ...current,
      hidden: current.hidden.filter((entry) => entry !== title),
    }));
    if (select) setActive(title);
  };

  const hide = (title: string) => {
    const name = displayName(title);
    const wasActive = active === title;
    setPrefs((current) => ({ ...current, hidden: [...current.hidden, title] }));
    if (wasActive) {
      const next = ordered.find((entry) => entry !== title && !prefs.hidden.includes(entry));
      if (next) setActive(next);
    }
    notify({
      action: { label: "Undo", run: () => restore(title, wasActive) },
      kind: `remove:${title}`,
      message: `${name} removed from the list`,
      tone: "info",
      ttl: TOAST_TTL.action,
    });
  };

  /**
   * Clear removed directions for good. Machine-local directions also leave
   * Leglas's registry on disk. Shared directions keep their source config
   * untouched and use the saved tombstone to stay out of this project's rail.
   */
  const deleteRemoved = async (removeTitles: readonly string[]) => {
    const unique = [...new Set(removeTitles)].filter((title) => prefs.hidden.includes(title));
    const local = unique.filter((title) => byTitle.get(title)?.local === true);

    if (local.length > 0) {
      const response = await fetch("/leglas/api/previews/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titles: local }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "The directions could not be deleted from Leglas.");
      }
    }

    const removed = new Set(unique);
    setPrefs((current) => deleteDirections(current, unique));
    setMounted((current) => current.filter((title) => !removed.has(title)));
    if (unique.includes(active)) {
      const next = ordered.find(
        (title) => !removed.has(title) && !prefs.hidden.includes(title),
      );
      setActiveRaw(next ?? "");
    }
    if (prefs.hidden.every((title) => removed.has(title))) setShowHidden(false);
  };

  /**
   * The rail's names also go to the server, because the name that comes out of
   * a rename is the one the user then says to their agent. Without this the
   * CLI answers that name with "no direction called that", which reads as the
   * direction being gone. Local state is not gated on the write: a rename is
   * theirs whether or not the disk agrees.
   */
  const setRenameValue = (title: string, value: string | undefined) =>
    setPrefs((current) => {
      const renames = { ...current.renames };
      if (value === undefined) delete renames[title];
      else renames[title] = value;
      void fetch("/leglas/api/renames", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ renames }),
      }).catch(() => {
        // Nothing to tell the user: the rail is renamed, and every command
        // still answers to the config title.
      });
      return { ...current, renames };
    });

  /** Open the rename form on a row, or close it; either way the error clears. */
  const startRename = (title: string | null) => {
    setRenaming(title);
    setRenameError(null);
  };

  /**
   * Submitting keeps the form open on a refused name so it can be corrected in
   * place; clicking away accepts that the rename is abandoned and says so
   * rather than trapping the cursor in a field the user has already left.
   */
  const rename = (title: string, raw: string, via: "blur" | "submit" = "submit") => {
    const names = new Map(titles.map((entry) => [entry, displayName(entry)]));
    const check = checkName(raw, title, names);

    if (check.kind === "taken") {
      if (via === "submit") {
        setRenameError(`${check.by} already goes by that name.`);
        return;
      }
      startRename(null);
      notify({
        kind: `rename:${title}`,
        message: `Still called ${displayName(title)}. ${check.by} already goes by that name.`,
        tone: "info",
        ttl: TOAST_TTL.plain,
      });
      return;
    }

    startRename(null);
    if (check.kind === "same") return;

    const before = prefs.renames[title];
    setRenameValue(title, check.kind === "reset" ? undefined : check.value);
    notify({
      action: { label: "Undo", run: () => setRenameValue(title, before) },
      kind: `rename:${title}`,
      message: check.kind === "reset" ? `Name reset to ${check.value}` : `Renamed to ${check.value}`,
      tone: "success",
      ttl: TOAST_TTL.action,
    });
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

      if (action.kind === "search" || action.kind === "request") {
        event.preventDefault();
        setPrefs((current) => (current.collapsed ? { ...current, collapsed: false } : current));
        // Both fields live in the rail, and a collapsed rail is inert, where
        // nothing can take focus. So the field is not focused here: the shell
        // does it in an effect, which React runs after the rail has committed
        // wide again. A timer would race that, and in a backgrounded window it
        // may not run at all.
        setFocusing({ target: action.kind, nonce: focusNonce.current++ });
      } else if (action.kind === "split") {
        event.preventDefault();
        onToggleSplit?.();
      } else if (action.kind === "help") {
        event.preventDefault();
        onToggleHelp?.();
      } else if (action.kind === "tools") {
        event.preventDefault();
        onToggleTools?.();
      } else if (action.kind === "note") {
        event.preventDefault();
        onToggleNote?.();
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
    onToggleTools,
    onToggleNote,
    suspended,
    // Re-attach as previews mount and as each one finishes loading, since a
    // fresh document does not inherit the old one's listener.
    mounted.join("|"),
    Object.entries(loaded)
      .filter(([, done]) => done)
      .map(([title]) => title)
      .join("|"),
  ]);

  /**
   * Two things are worth copying about a direction, and they are wanted at
   * different moments. The link is the reflex: someone says "show me" and it
   * goes straight into a message. The reference is the considered one, for
   * handing a direction to a teammate or an agent with what it is and the file
   * behind it. Each gets its own control rather than one control with a
   * choice hung off it, so neither costs a second click.
   *
   * The tick on the button is the fast answer and the toast is the durable
   * one, because the button that was clicked is often gone from under the
   * cursor by the time the eye gets back to it. A clipboard that refused shows
   * neither: it shows the link instead, which is the one part small enough to
   * retype.
   */
  const copy = (title: string, kind: CopyKind) => {
    const url = absoluteUrl(urlFor(title), window.location.origin);
    const text =
      kind === "link"
        ? url
        : referenceText({
            displayName: displayName(title),
            preview: byTitle.get(title),
            previewUrl: url,
            title,
          });
    void copyText(text).then((outcome) => {
      if (outcome === "blocked") {
        setCopied(null);
        notify({
          detail: url,
          kind: "copy",
          message: "Your browser blocked the clipboard. The direction is at:",
          tone: "danger",
          ttl: null,
        });
        return;
      }
      setCopied({ kind, title });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1200);
      notify({
        kind: "copy",
        message:
          kind === "link"
            ? `Link to ${displayName(title)} copied`
            : `Reference to ${displayName(title)} copied`,
        tone: "success",
        ttl: TOAST_TTL.plain,
      });
    });
  };

  const copyLink = (title: string) => copy(title, "link");
  const copyReference = (title: string) => copy(title, "reference");

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

  const markLoaded = (title: string, identity: string) =>
    setLoaded((current) => markPreviewLoaded(current, title, identity));

  const isLoaded = (title: string, identity: string) => previewIsLoaded(loaded, title, identity);

  /** Drop a pane's loaded flag so its skeleton shows again on a forced reload. */
  const resetLoaded = (title: string) =>
    setLoaded((current) => resetPreviewLoaded(current, title));

  const panes = nested ? [active] : titles.filter((title) => mounted.includes(title));

  return {
    active,
    copied,
    copyLink,
    copyReference,
    deleteRemoved,
    displayName,
    dismissToast: dismiss,
    focusing,
    hiddenCount: prefs.hidden.length,
    hide,
    isLoaded,
    loaded,
    markLoaded,
    matches,
    moveOption,
    nested,
    notify,
    onHandlePointerDown,
    panes,
    prefs,
    previewFor: (title: string) => byTitle.get(title),
    query,
    rename,
    renameError,
    renaming,
    parentOf,
    resetLoaded,
    resizing,
    restore,
    rowMeta,
    rows,
    toggleFamily,
    setActive,
    setPrefs,
    setQuery,
    setShowHidden,
    showHidden,
    startRename,
    toasts,
    urlFor,
    branchState,
    startBranch,
    visibleCount,
    viewports: VIEWPORTS,
  };
}

export type ShellState = ReturnType<typeof useShellState>;
