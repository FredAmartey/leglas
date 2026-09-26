import { useEffect, useRef, useState } from "react";

import {
  MAX_W,
  MIN_W,
  VIEWPORTS,
  deleteDirections,
  loadPrefs,
  railOrder,
  storageKey,
  type Prefs,
} from "./prefs.js";
import { ancestry, lineageRail, reorderAmongSiblings, widestLane } from "./lineage/lineage.js";
import { railInsets } from "./lineage/Gutter.js";
import { copyText } from "./ui/clipboard.js";
import { resolveKey } from "./keymap.js";
import { checkName } from "./naming.js";
import { absoluteUrl, referenceText } from "./reference.js";
import { markPreviewLoaded, previewIsLoaded, resetPreviewLoaded } from "./preview/preview-frame.js";
import { dismissToast, pushToast, TOAST_TTL, type Toast } from "./ui/toasts.js";
import { adoptLayout, viewerPrefsRaw } from "./share/share.js";
import type { BranchPreviewState, Preview, ShareLayout } from "./types.js";
import { refusal } from "./net/api.js";

/**
 * The engine under every shell body: prefs, selection, search, rename and
 * remove, copy, keyboard, resize and pane mounting. Bodies own the look, this
 * owns the behaviour, so the interface can be explored as a design surface
 * without reimplementing its mechanics.
 *
 * Anything that changes the list reports it: copy, rename and remove end in a
 * toast naming the direction, and the two reversible ones carry an undo. Pane
 * history is recorded on activation; nested shells expose only the active pane
 * so self-hosting never multiplies iframes.
 */
/** The link on its own, or the block that says what the direction is. */
export type CopyKind = "link" | "reference";

export type ShellStateProps = {
  previews: readonly Preview[];
  project: string;
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
  /**
   * Set when opened through a share link. The rail is seeded from the sharer's
   * layout and nothing is saved or sent: a viewer's choices last their tab.
   */
  viewer?: { layout: ShareLayout } | undefined;
};

export function useShellState({
  previews,
  project,
  onToggleSplit,
  onToggleHelp,
  onToggleTools,
  onToggleNote,
  suspended = false,
  viewer,
}: ShellStateProps) {
  const key = storageKey(project);

  const initial = () =>
    loadPrefs(
      viewer !== undefined
        ? viewerPrefsRaw(viewer.layout)
        : typeof window === "undefined"
          ? null
          : window.localStorage.getItem(key),
      previews,
    );

  const [prefs, setPrefs] = useState<Prefs>(initial);
  const byTitle = new Map(previews.map((preview) => [preview.title, preview]));

  const firstVisible = () => {
    const saved = initial();

    return saved.order.find((title) => !saved.hidden.includes(title)) ?? saved.order[0] ?? "";
  };

  const [active, setActiveRaw] = useState<string>(firstVisible);
  const nested = typeof window !== "undefined" && window.self !== window.top;
  const [mounted, setMounted] = useState<readonly string[]>(() => [firstVisible()]);
  const [query, setQueryRaw] = useState("");
  /**
   * Folds made during a search, scoped to it. Starting empty lets a fresh query
   * reveal folded variants, and folding here leaves the saved preference alone:
   * tidying while searching is a viewing gesture.
   */
  const [searchFolded, setSearchFolded] = useState<readonly string[]>([]);

  const setQuery = (value: string) => {
    // A new query is a new search; folds made against the old one are stale.
    setSearchFolded((current) => (current.length ? [] : current));
    setQueryRaw(value);
  };

  const [showHidden, setShowHidden] = useState(false);
  /**
   * Rows folded for a drag. A lineage rail folds the families around the moving
   * row, so its possible slots are exactly the rows on screen; the fold lifts
   * when the drag ends.
   */
  const [dragFolded, setDragFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Why the open rename form refused what was typed into it. */
  const [renameError, setRenameError] = useState<string | null>(null);
  /** Which control just copied, so the tick lands on that one and not its twin. */
  const [copied, setCopied] = useState<{ kind: CopyKind; title: string } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  /**
   * A field the keyboard asked for, focused by the shell once its rail renders.
   * The nonce makes the same key twice a second request.
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
    if (viewer !== undefined) return;
    window.localStorage.setItem(key, JSON.stringify(prefs));
  }, [prefs, key, viewer]);

  /**
   * The sharer pushed their current view: layout fields are taken, the viewer's
   * own settings stay. Keyed on the layout's bytes (the object is fresh every
   * read) and settled during render so the old rail never shows.
   */
  const viewerLayout = viewer === undefined ? null : viewerPrefsRaw(viewer.layout);
  const [seededFrom, setSeededFrom] = useState(viewerLayout);

  if (viewerLayout !== seededFrom) {
    setSeededFrom(viewerLayout);

    if (viewer !== undefined) setPrefs((current) => adoptLayout(current, viewer.layout, previews));
  }

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const displayName = (title: string) => prefs.renames[title] ?? title;
  const urlFor = (title: string) => byTitle.get(title)?.url ?? "/";

  /** A branch preview's checkout state, or null for a plain route with nothing to start. */
  const branchState = (title: string): BranchPreviewState | null => {
    const preview = byTitle.get(title);

    return preview?.branch === undefined ? null : (preview.state ?? { status: "idle" });
  };

  /**
   * Asks the server to bring a branch up. Safe to repeat: the server joins a
   * start in flight, so opening twice during boot is one checkout and a failed
   * one retries. The result arrives through the live config nudge.
   */
  const startBranch = (title: string) => {
    // A branch never reaches a viewer, and a viewer cannot start one anyway.
    if (viewer !== undefined) return;
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

  // Recomputed every render, so previews an agent registers mid-session get
  // rows at once.
  const ordered = railOrder(prefs.order, titles);

  // Variants sit under their base direction and a collapsed family folds them
  // away. During a search the saved folds give way to the per-search set, so a
  // match reveals a folded variant and the fold control works on what's shown.
  // Computed from visible titles, so hiding a direction promotes its variants
  // to roots.
  const searching = query.trim() !== "";
  const foldedNow = searching ? searchFolded : prefs.collapsedFamilies;

  const basedOnMap = new Map(
    previews.flatMap((preview) =>
      preview.basedOn === undefined ? [] : [[preview.title, preview.basedOn] as const],
    ),
  );

  const showing = ordered.filter((title) => !prefs.hidden.includes(title) && matches(title));

  const {
    rows,
    meta: rowMeta,
    parents: railParents,
    children: railChildren,
    roots: railRoots,
  } = lineageRail(showing, basedOnMap, new Set([...foldedNow, ...dragFolded]));

  // Card starts are measured with every family open, so neither a fold nor a
  // drag's folding moves a card sideways.
  const insets = railInsets(lineageRail(showing, basedOnMap, new Set()).meta);

  /** Move a direction among its siblings; see reorderAmongSiblings. */
  const reorderAmong = (title: string, before: string | null, siblings: readonly string[]) =>
    setPrefs((current) => ({
      ...current,
      order: reorderAmongSiblings(
        current.order,
        previews.map((preview) => preview.title),
        title,
        before,
        siblings,
      ),
    }));

  /** Where a direction came from, root first, for a rail that shows the chain. */
  const ancestryOf = (title: string) => ancestry(title, basedOnMap);
  /** The widest gutter lane any row touches, or -1 when no row draws one. */
  const lanes = widestLane(rowMeta);

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

  /**
   * Puts a removed direction back in its own slot (removal leaves order alone),
   * and back on stage if it was there: a restore that leaves you looking
   * elsewhere is half an undo.
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
   * Clears removed directions for good. Machine-local ones also leave the
   * registry on disk; shared ones keep their config and stay off this rail by
   * tombstone.
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
        throw await refusal(response, "The directions could not be deleted from Leglas.");
      }
    }

    const removed = new Set(unique);
    setPrefs((current) => deleteDirections(current, unique));
    setMounted((current) => current.filter((title) => !removed.has(title)));

    if (unique.includes(active)) {
      const next = ordered.find((title) => !removed.has(title) && !prefs.hidden.includes(title));
      setActiveRaw(next ?? "");
    }

    if (prefs.hidden.every((title) => removed.has(title))) setShowHidden(false);
  };

  /**
   * Rail names also go to the server, since the renamed name is what the user
   * says to their agent; otherwise the CLI answers "no direction called that".
   * Local state doesn't wait on the write.
   */
  const setRenameValue = (title: string, value: string | undefined) =>
    setPrefs((current) => {
      const renames = { ...current.renames };

      if (value === undefined) delete renames[title];
      else renames[title] = value;

      if (viewer !== undefined) return { ...current, renames };
      void fetch("/leglas/api/renames", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ renames }),
      }).catch(() => {
        // Nothing to report: the rail is renamed and commands still take the
        // config title.
      });

      return { ...current, renames };
    });

  /** Open the rename form on a row, or close it; either way the error clears. */
  const startRename = (title: string | null) => {
    setRenaming(title);
    setRenameError(null);
  };

  /**
   * A submit keeps the form open on a refused name for correction in place;
   * clicking away abandons the rename and says so rather than pulling the
   * cursor back.
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
      message:
        check.kind === "reset" ? `Name reset to ${check.value}` : `Renamed to ${check.value}`,
      tone: "success",
      ttl: TOAST_TTL.action,
    });
  };

  // Which key does what lives in keymap.ts; this only carries the actions out.
  useEffect(() => {
    const cycle = rows;

    const onKey = (event: KeyboardEvent) => {
      // SAFETY: read by tag rather than instanceof, because a target inside a
      // preview comes from that frame's realm, where the parent's
      // HTMLInputElement never matches, and every keystroke typed into the app
      // would look like a shortcut.
      const target = event.target as HTMLElement | null;
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

      // A viewer has no composer and nothing to annotate, so those keys do
      // nothing.
      if (viewer !== undefined && (action.kind === "request" || action.kind === "note")) return;

      if (action.kind === "search" || action.kind === "request") {
        event.preventDefault();
        setPrefs((current) => (current.collapsed ? { ...current, collapsed: false } : current));
        // Both fields live in the rail, and a collapsed rail is inert and
        // refuses focus, so the shell focuses in an effect after the rail
        // commits wide again. A timer would race that and may not run in a
        // background window.
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
        // Past the end is a miss, not the last direction: the digit names a
        // slot.
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
     * Clicking a design moves focus into its frame, where keydown never reaches
     * this window, so shortcuts went dead. Listening on each same-origin
     * preview keeps them working; a cross-origin one keeps its own keyboard.
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

    // SAFETY: registered for keydown only, so every event is a KeyboardEvent;
    // the union of windows and documents hides the typed overload.
    const listener = onKey as EventListener;

    for (const target of targets) target.addEventListener("keydown", listener);

    return () => {
      for (const target of targets) target.removeEventListener("keydown", listener);
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
    // Re-attach as previews mount and finish loading, since a fresh document
    // doesn't inherit the listener.
    mounted.join("|"),
    Object.entries(loaded)
      .filter(([, done]) => done)
      .map(([title]) => title)
      .join("|"),
  ]);

  /**
   * Two copies, wanted at different moments: the link, the reflex for "show
   * me", and the reference, which says what the direction is and its file, for
   * a teammate or agent. Each has its own control, so neither costs a second
   * click.
   *
   * The tick on the button is the quick answer and the toast the durable one,
   * since the button is often gone by the time the eye returns. A refused
   * clipboard shows the link instead, the part small enough to retype.
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

  // Pointer capture keeps moves routed to the handle even over the preview
  // iframe, a separate document that swallows pointer events.
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
  const resetLoaded = (title: string) => setLoaded((current) => resetPreviewLoaded(current, title));

  const panes = nested ? [active] : titles.filter((title) => mounted.includes(title));

  return {
    active,
    ancestryOf,
    copied,
    copyLink,
    copyReference,
    deleteRemoved,
    displayName,
    dismissToast: dismiss,
    dragFolded,
    focusing,
    hiddenCount: prefs.hidden.length,
    hide,
    isLoaded,
    lanes,
    insets,
    loaded,
    markLoaded,
    matches,
    nested,
    notify,
    onHandlePointerDown,
    panes,
    prefs,
    railChildren,
    railParents,
    railRoots,
    reorderAmong,
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
    setDragFolded,
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
    /** Whether this rail is somebody else's, opened through a share link. */
    viewing: viewer !== undefined,
  };
}

export type ShellState = ReturnType<typeof useShellState>;
