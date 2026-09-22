import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

import { Mark, P, PIcon, Tip, Toasts } from "./ui/kit.js";
import { copyText } from "./ui/clipboard.js";
import { searchCap } from "./keymap.js";
import { FALLBACK_MS, liveConnection } from "./net/live.js";
import { startPoll } from "./net/poll.js";
import {
  previewFrameIsReady,
  previewIdentity,
  watchPreviewFrame,
} from "./preview/preview-frame.js";
import { previewFrameForSource, previewMessageSignal } from "./preview/preview-message.js";
import {
  INITIAL_HEALTH,
  needsDevServer,
  nextHealthState,
  type HealthState,
} from "./preview/health.js";
import { nextCompare, paneGeometry, paneTitles } from "./preview/compare.js";
import { BADGE_CSS, NEXT_BADGE_CSS } from "./preview/overlays.js";
import { paintSample, renderedSignature, twinsOf, visualSample } from "./preview/rendered.js";
import {
  forgetScans,
  recordScan,
  replacedPanes,
  scanQueue,
  scanSignatures,
  type PreviewScan,
  type PreviewScanOutcome,
} from "./preview/scan.js";
import { clampWidget, dragAnchor, isDrag, nearestCorner } from "./ui/widget.js";
import { EASE } from "./prefs.js";
import { gutterWidth } from "./lineage/Gutter.js";
import { flushSync } from "react-dom";
import { Crumbs } from "./lineage/Crumbs.js";
import {
  segmentsOf,
  tracedSegments,
  tracedTree,
  trailPath,
  type Mark as TrailMark,
  type Segment,
} from "./lineage/lineage.js";
import { PALETTE, Trail } from "./lineage/Trail.js";
import { TOAST_TTL } from "./ui/toasts.js";
import { useShellState } from "./useShellState.js";
import { provenanceLine, provenanceOf } from "./lineage/provenance.js";
import { AnnotateLayer } from "./annotate/AnnotateLayer.js";
import { ReferenceStrip } from "./references/ReferenceStrip.js";
import { uploadReference } from "./references/references-api.js";
import {
  REFERENCE_CAP,
  admit,
  carriesFiles,
  displayName as referenceName,
  referenceIds,
  refusalMessage,
  sendBlocker,
  type ReferenceDraft,
} from "./references/references.js";
import type { Anchor } from "./annotate/anchor.js";
import {
  addNote,
  deleteNotes,
  readNotes,
  updateNote,
  type Annotation,
  type NoteFetcher,
} from "./annotate/annotations-api.js";
import type { Preview, ViewerInfo } from "./types.js";
import {
  changingRequestTitles,
  composerAgent,
  notesAwaitingChange,
  requestCard,
  workingRequestTitles,
  type AgentEffort,
  type AgentStatus,
  type RequestStatus,
} from "./agents/request-status.js";
import {
  cancelAgentRun,
  chooseAgent,
  chooseAgentEffort,
  dismissFailedRequest,
  readAgents,
  retryFailedRequest,
  warmAgent,
  type AgentsPayload,
} from "./agents/agent-api.js";
import { McpConnectDialog } from "./agents/McpConnectDialog.js";
import { AgentPicker } from "./agents/AgentPicker.js";
import { StatusCard } from "./agents/StatusCard.js";
import { AnnotateButton } from "./composer/AnnotateButton.js";
import { AttachButton } from "./composer/AttachButton.js";
import { ModeChip } from "./composer/ModeChip.js";
import { SendButton } from "./composer/SendButton.js";
import { Pane } from "./stage/Pane.js";
import { ToolsPopover } from "./stage/ToolsPopover.js";
import { FONTS } from "./ui/fonts.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { DeleteRemovedDialog } from "./rail/DeleteRemovedDialog.js";
import type { Drag, DragMeta } from "./rail/drag.js";
import { RailHeader } from "./rail/Header.js";
import { RailRow } from "./rail/Row.js";
import { Search } from "./rail/Search.js";
import { ViewerBanner } from "./share/ViewerBanner.js";

/** How long a preview may take before it is treated as failed. */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * How often the composer taking focus is allowed to ask for a warm agent. The
 * server keeps one warm for minutes after an ask, so a click-happy hand does
 * not need to send more than one in a while.
 */
const WARM_THROTTLE_MS = 30_000;

/** One render size makes duplicate verdicts independent of the visible stage. */
const DUPLICATE_VIEWPORT = { height: 800, width: 1280 } as const;

/**
 * The rail's foot before it is first measured. The real height moves with the
 * status card above the composer, so toasts read it from a ResizeObserver and
 * this only covers the frame before that observer reports.
 */
const RAIL_FOOTER_FALLBACK_H = 96;

const IDLE_AGENT: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
  startedAt: null,
  stopping: false,
  waiting: null,
};

const EMPTY_AGENTS: AgentsPayload = {
  agents: [],
  choice: null,
  customRun: null,
  effort: null,
};

/** Whether to write the search chord as Cmd or Ctrl. Read once, never changes. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const SEARCH_CAP = searchCap(IS_MAC);

/** The rail's top and bottom edges, over which its rows and lines fade. */
const RAIL_FADE =
  "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)";

type DeletePrompt = {
  error: string | null;
  titles: readonly string[];
};

/**
 * The Leglas chrome. Warm dark surfaces (#1C1C20 main, #1E1E22 strips,
 * #232328 borders, #2E2E2E inputs), a 368px rail, two type tiers, flat rows
 * with a sliding highlight and a hover-revealed action cluster, drag to
 * reorder, hidden scrollbars, no top bar, and a floating widget whose popover
 * holds the typeface picker, viewport presets, copy, and open-in-tab.
 */
export function Shell({
  previews,
  project,
  scanPreviews = true,
  viewer,
  warnings = [],
}: {
  previews: Preview[];
  project: string;
  scanPreviews?: boolean;
  /** Set when this interface was opened through a share link. */
  viewer?: ViewerInfo | undefined;
  warnings?: readonly string[];
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef<HTMLTextAreaElement | null>(null);
  const splitRef = useRef<(() => void) | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null);
  const [mcpConnectOpen, setMcpConnectOpen] = useState(false);
  const [deletingRemoved, setDeletingRemoved] = useState(false);
  // Stable, so the window key listener attaches once rather than on every
  // render of the shell.
  const onToggleSplit = useCallback(() => splitRef.current?.(), []);
  const onToggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const [widgetOpen, setWidgetOpen] = useState(false);
  // The way into the tools when the widget is switched off the stage.
  const onToggleTools = useCallback(() => setWidgetOpen((open) => !open), []);
  const onToggleNote = useCallback(() => setAnnotating((on) => !on), []);

  const st = useShellState({
    previews,
    project,
    searchRef,
    onToggleSplit,
    onToggleHelp,
    onToggleTools,
    // A viewer has nothing to annotate with, so the key does nothing rather
    // than opening a mode whose every write would be refused.
    onToggleNote: viewer === undefined ? onToggleNote : undefined,
    // While the keymap is on screen it is the subject, not a way to drive what
    // is behind it. ? still closes it.
    suspended: helpOpen || deletePrompt !== null || mcpConnectOpen,
    viewer: viewer === undefined ? undefined : { layout: viewer.layout },
  });

  /**
   * Somebody else's rail, opened through a share link. Everything that looks
   * stays; everything that changes what runs, or what the sharer sees, goes.
   */
  const viewing = st.viewing;
  /** The lineage gutter's width, shared by every row so the titles align. */
  const gutter = gutterWidth(st.lanes);
  const insets = st.insets;
  /** The light's own colour, for a working mark's breath and for blooms. */
  const tint = PALETTE.current[0];
  /**
   * Titles the rail has shown before. A row not among them just arrived, an
   * agent's new direction landing, and the rail marks the moment; a row
   * returning from a fold is not an arrival.
   */
  const known = useRef<Set<string> | null>(null);
  const arrivedAt = useRef(new Map<string, number>());

  const arrivingNow = (title: string): boolean => {
    if (known.current === null) return false;

    if (!known.current.has(title) && !arrivedAt.current.has(title)) {
      arrivedAt.current.set(title, performance.now());
    }

    const at = arrivedAt.current.get(title);

    return at !== undefined && performance.now() - at < 1000;
  };

  /** A new direction blooms where it lands and on the direction it attaches to. */
  const arriving = (title: string) =>
    arrivingNow(title) || (st.railChildren.get(title) ?? []).some((child) => arrivingNow(child));

  useEffect(() => {
    const seen = known.current ?? new Set<string>();

    for (const title of st.rows) seen.add(title);
    known.current = seen;
  });
  /** The row a crumb rests on blooms once each time one does, then the bloom is let go. */
  const [crumbBloom, setCrumbBloom] = useState({ nonce: 0, title: "" });
  useEffect(() => {
    if (crumbBloom.title === "") return;
    const timer = setTimeout(() => setCrumbBloom((current) => ({ ...current, title: "" })), 950);

    return () => clearTimeout(timer);
  }, [crumbBloom]);
  /**
   * The direction whose line back to its root is lit in the gutter: the one
   * under the pointer, in the rail or in the crumbs, and otherwise the one on
   * stage, so the graph always says where what you are looking at came from.
   */
  const [traced, setTracedNow] = useState<string | null>(null);
  /**
   * A hover re-aims the light only once the pointer has rested. A hand
   * sweeping down the rail crosses every row on the way, and re-aiming at
   * each of them, each with its own fade, turns the light into a flicker
   * that follows the pointer instead of answering it. Leaving is immediate.
   */
  const tracePending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setTraced = useCallback((title: string | null) => {
    if (tracePending.current) clearTimeout(tracePending.current);
    tracePending.current = null;

    if (title === null) {
      setTracedNow(null);

      return;
    }

    tracePending.current = setTimeout(() => {
      tracePending.current = null;
      setTracedNow(title);
    }, 120);
  }, []);

  useEffect(
    () => () => {
      if (tracePending.current) clearTimeout(tracePending.current);
    },
    [],
  );

  /**
   * The line the light runs along, and the segments under it. One answer,
   * used twice.
   *
   * A hover only takes the light when the row under the pointer has a line of
   * its own. Sweeping across the rail passes over directions with no lineage,
   * and re-aiming at those would put the light out and light it again for
   * every one of them, which reads as the rail flickering rather than as an
   * answer to where the pointer is.
   */
  const treeOf = (title: string) =>
    title === "" ? { nodes: [], edges: [] } : tracedTree(st.railParents, st.railChildren, title);

  const hovered = traced !== null ? treeOf(traced) : { nodes: [], edges: [] };
  const litTree = hovered.edges.length > 0 ? hovered : treeOf(st.active);
  const litSegments = tracedSegments(st.rows, st.rowMeta, litTree);
  /**
   * Which segments each row has already drawn, so only what is new draws
   * itself in: the whole rail on first sight, then just the line an agent's
   * next direction adds, and a family's lines again when it is unfolded,
   * since only rows on screen are remembered. Rows are remembered a beat
   * after they render, so a re-render mid-animation keeps the class and the
   * stroke keeps going.
   */
  const drawnSegments = useRef(new Map<string, Set<string>>());
  /** Whether this render handed any segment the drawing class. */
  const drawing = useRef(false);
  drawing.current = false;
  // A render after the drawing settles, so the classes come off once the
  // strokes are in. Only asked for when something was drawing: a render that
  // drew nothing settles nothing, which is what keeps this from looping.
  const [, settle] = useReducer((count: number) => count + 1, 0);

  const freshFor = (title: string): Set<Segment> | undefined => {
    const graph = st.rowMeta.get(title)?.graph;

    if (!graph) return undefined;
    const drawn = drawnSegments.current.get(title);
    const fresh = new Set(segmentsOf(graph).filter((segment) => !drawn?.has(segment)));

    if (fresh.size > 0) drawing.current = true;

    return fresh;
  };

  // Keyed on what the gutter draws, not on renders: the shell re-renders
  // for polls and frames far more often than every 700ms, and a timer reset
  // on each of those would never fire.
  const gutterSignature = st.rows
    .map((title) => {
      const graph = st.rowMeta.get(title)?.graph;

      return graph ? `${title}=${segmentsOf(graph).join(",")}` : title;
    })
    .join("|");

  useEffect(() => {
    const snapshot = st.rows.map((title) => [title, st.rowMeta.get(title)?.graph] as const);
    const wasDrawing = drawing.current;

    const timer = setTimeout(() => {
      drawnSegments.current = new Map(
        snapshot.flatMap(([title, graph]) =>
          graph ? [[title, new Set<string>(segmentsOf(graph))] as const] : [],
        ),
      );

      if (wasDrawing) settle();
    }, 700);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gutterSignature]);

  /**
   * Folding on a graph rail is a change of layout the browser can animate:
   * the rows that stay slide to their new places and the rows that go fade,
   * instead of the list snapping to its new shape.
   */
  const foldFamily = (title: string) => {
    if (!stillMotion && typeof document.startViewTransition === "function") {
      document.startViewTransition(() => flushSync(() => st.toggleFamily(title)));

      return;
    }

    st.toggleFamily(title);
  };

  /** A crumb under the pointer lights its row as well as its line. */
  const traceFromCrumb = (title: string | null) => {
    setTraced(title);

    if (title === null) {
      setGlow((current) => ({ ...current, on: false }));

      return;
    }

    setCrumbBloom((current) => ({ nonce: current.nonce + 1, title }));

    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-title]") ?? [])].find(
      (entry) => entry.dataset.title === title,
    );

    if (row) setGlow(glowFor(row));
  };

  const closeDeletePrompt = () => {
    if (!deletingRemoved) setDeletePrompt(null);
  };

  const confirmDeleteRemoved = async () => {
    if (deletePrompt === null || deletingRemoved) return;
    const prompt = deletePrompt;
    setDeletingRemoved(true);
    setDeletePrompt({ ...prompt, error: null });

    try {
      await st.deleteRemoved(prompt.titles);
      setDeletePrompt(null);
      st.notify({
        kind: `delete:${prompt.titles.join("|")}`,
        message:
          prompt.titles.length === 1
            ? `${st.displayName(prompt.titles[0] ?? "")} permanently deleted`
            : `${prompt.titles.length} removed directions permanently deleted`,
        tone: "info",
        ttl: TOAST_TTL.plain,
      });
    } catch (error) {
      setDeletePrompt({
        ...prompt,
        error: error instanceof Error ? error.message : "The directions could not be deleted.",
      });
    } finally {
      setDeletingRemoved(false);
    }
  };

  // The widget is the only way into the tools, so it must never end up under
  // the pointer-blocked overlay of a busy drag, nor off-stage after a resize.
  const [widgetDrag, setWidgetDrag] = useState<{ x: number; y: number } | null>(null);
  const widgetDragging = widgetDrag !== null;
  // Pointer capture keeps the click alive through a drag, so the press that
  // parked the widget in a corner would also spring the tools open. The rail
  // suppresses its post-drag click the same way.
  const widgetClickSuppressed = useRef(false);
  // Expressing an intent used to mean leaving for a terminal. This keeps it
  // where the direction is being looked at; the user's own agent still does
  // the work, because it knows the codebase and Leglas does not.
  //
  // It sits under the rail rather than inside the tools popover, where it was
  // the one thing among the preferences that acted on the work, two clicks
  // deep, addressing a direction the panel never named. Under the list, the
  // direction it means is the highlighted row directly above it.
  const [intent, setIntent] = useState("");
  /**
   * Whether the next change forks the direction or rewrites it.
   *
   * Variant every session, deliberately not remembered: the two do different
   * work and only one of them can be undone, so the safe half is what a fresh
   * window starts on. The chip beside the send button carries the state, so
   * which one is armed is never a guess.
   */
  const [mode, setMode] = useState<"variant" | "replace">("variant");
  // The field is a textarea that wears one row until the words need more,
  // then grows line by line to a cap. Measured from scrollHeight because
  // wrapping depends on the rail width and the face the user picked.
  useEffect(() => {
    const field = requestRef.current;

    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 96)}px`;
  }, [intent, st.prefs.width]);
  const [sending, setSending] = useState(false);
  /**
   * Reference images riding with the next change.
   *
   * Uploaded as they arrive rather than when the request is sent, so the
   * send only names ids and the strip can be honest about which ones landed.
   * The drafts carry everything the strip draws; the File objects wait in a
   * ref for a retry, since a draft that failed still has the bytes to try
   * again with.
   */
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const referenceFiles = useRef(new Map<string, File>());
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  // A drag is counted in and out rather than flagged, because entering a
  // child fires leave on the parent, and a single boolean flickers every time
  // the pointer crosses the field.
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);

  const uploadReferenceDraft = useCallback((key: string, file: File) => {
    referenceFiles.current.set(key, file);
    setReferences((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, status: "uploading", id: null } : draft,
      ),
    );
    void uploadReference(file)
      .then(({ id }) =>
        setReferences((current) =>
          current.map((draft) => (draft.key === key ? { ...draft, status: "ready", id } : draft)),
        ),
      )
      .catch(() =>
        setReferences((current) =>
          current.map((draft) =>
            draft.key === key ? { ...draft, status: "failed", id: null } : draft,
          ),
        ),
      );
  }, []);

  const attachReferences = (files: readonly File[]) => {
    if (st.active === null || sending) return;
    const { accepted, refused } = admit(references, files);
    const message = refusalMessage(refused);

    if (message !== null) {
      st.notify({ kind: "reference", message, tone: "info", ttl: TOAST_TTL.action });
    }

    if (accepted.length === 0) return;

    const drafts = accepted.map((file): ReferenceDraft => ({
      key: crypto.randomUUID(),
      name: referenceName(file.name),
      type: file.type,
      bytes: file.size,
      url: URL.createObjectURL(file),
      status: "uploading",
      id: null,
    }));

    setReferences((current) => [...current, ...drafts]);
    drafts.forEach((draft, index) => {
      const file = accepted[index];

      if (file !== undefined) uploadReferenceDraft(draft.key, file);
    });
  };

  const removeReference = (key: string) => {
    referenceFiles.current.delete(key);
    const leaving = references.find((draft) => draft.key === key);

    if (leaving !== undefined) URL.revokeObjectURL(leaving.url);
    setReferences((current) => current.filter((draft) => draft.key !== key));
  };

  const retryReference = (key: string) => {
    const file = referenceFiles.current.get(key);

    if (file !== undefined) uploadReferenceDraft(key, file);
  };

  const clearReferences = () => {
    referenceFiles.current.clear();

    for (const draft of references) URL.revokeObjectURL(draft.url);
    setReferences([]);
  };

  const [pickingAgent, setPickingAgent] = useState<string | null>(null);
  const [savingEffort, setSavingEffort] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [requestAction, setRequestAction] = useState<"cancel" | "retry" | "dismiss" | null>(null);
  const widgetButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const agentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mcpConnectTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Toasts stack on top of the rail's foot, whose height now moves with the
  // status card, so they follow a measurement instead of a constant.
  const railFooterRef = useRef<HTMLDivElement | null>(null);
  const [railFooterH, setRailFooterH] = useState(RAIL_FOOTER_FALLBACK_H);
  useEffect(() => {
    const node = railFooterRef.current;

    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setRailFooterH(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  // One white/6% panel behind the hovered row that eases between rows. The
  // active row carries its own persistent surface, so this is hover-only.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [glow, setGlow] = useState({ height: 0, left: 0, on: false, top: 0 });

  // The glow covers the card, not the row: a card starts past the gutter its
  // lineage lives in, so the glow starts where the card does.
  const glowFor = (row: HTMLElement) => ({
    height: row.offsetHeight,
    left: row.querySelector<HTMLElement>('[role="button"]')?.offsetLeft ?? 0,
    on: true,
    top: row.offsetTop,
  });

  // The panel is measured from the row the pointer entered, and rows move as
  // a search narrows the list or a family folds. Left on, it hangs over
  // whatever now occupies that spot, so any change to the rows puts it away
  // until the pointer says where it is again.
  useEffect(() => {
    setGlow((current) => (current.on ? { ...current, on: false } : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.rows.join("|")]);

  // Window-level listeners rather than pointer capture, so a drag survives
  // leaving the rail; a 4px threshold separates it from a click.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragMeta = useRef<DragMeta | null>(null);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  /**
   * Cmd K and R name a field in the rail; this puts the cursor in it. It runs
   * as an effect rather than from the key handler because both keys open a
   * collapsed rail on the way, and until React has committed that, the field
   * is still inside an inert subtree, where focus is refused.
   */
  useEffect(() => {
    if (!st.focusing) return;
    const field = st.focusing.target === "search" ? searchRef.current : requestRef.current;
    field?.focus();
    field?.select();
  }, [st.focusing]);

  useEffect(() => {
    if (!drag) return;
    const meta = dragMeta.current;

    if (!meta) return;

    const onMove = (event: PointerEvent) => {
      const dy = event.clientY - meta.startY;
      const dx = event.clientX - meta.startX;
      setDrag((current) => {
        if (!current || current.settling) return current;

        if (!current.started) {
          // Nothing is decided inside the threshold.
          if (Math.abs(dy) <= 4 && Math.abs(dx) <= 4) return { ...current, dy };

          // The first real movement chooses which gesture this press was:
          // down the list reorders, across a line selects the text under the
          // pointer. Both live on the same surface because a row is a handle
          // and a row is words, and asking the user to find the sliver that
          // is only one of them is what made reordering feel broken.
          if (Math.abs(dx) > Math.abs(dy)) return null;
          // Whatever the browser painted on the way to the threshold goes;
          // from here the rail is `select-none` and nothing can extend it.
          window.getSelection()?.removeAllRanges();
          // The rows around this one fold away for the drag, so what can be
          // ordered is exactly what is on screen and a family travels as one
          // row. Positions are measured again once the fold has laid out.
          st.setDragFolded(
            new Set(
              meta.siblings.filter((sibling) => (st.rowMeta.get(sibling)?.descendants ?? 0) > 0),
            ),
          );

          return { ...current, dy: 0, measured: false, started: true };
        }

        if (!current.measured) return current;
        const row = meta.rows[current.from];

        if (!row) return current;
        // Where the row would sit if it took each slot its siblings offer.
        // Rows differ in height, so the slot is chosen by which of these the
        // row is nearest rather than by crossing midpoints: that keeps the
        // travel and the target in step, and the two ends exactly reachable.
        // The span is set by the remeasure once the fold has laid out, and
        // the siblings it comes from always include the dragged row itself,
        // so the whole-rail fallback here only covers the frames before that
        // remeasure has run; it never widens a family's slots to the rail.
        const [first, last] = current.span ?? [0, meta.rows.length - 1];

        const slotTop = (index: number): number => {
          const slot = meta.rows[index];

          if (!slot) return row.top;

          return index <= current.from ? slot.top : slot.top + slot.height - row.height;
        };

        const low = slotTop(first) - row.top;
        const high = slotTop(last) - row.top;
        // The pointer gets a row of give; the row itself shows a third of
        // that, so it peeks past the edge without covering the neighbour.
        const give = row.height;
        const peek = give / 3;
        let bounded = dy;
        let blocked = false;

        if (dy < low) {
          bounded = low + Math.max(-peek, (dy - low) * 0.3);
          blocked = dy < low - give;
        } else if (dy > high) {
          bounded = high + Math.min(peek, (dy - high) * 0.3);
          blocked = dy > high + give;
        }

        bounded = Math.max(meta.minDy, Math.min(meta.maxDy, bounded));
        const wanted = row.top + Math.max(low, Math.min(high, dy));
        let to = current.from;
        let nearest = Infinity;

        for (let index = first; index <= last; index += 1) {
          const distance = Math.abs(slotTop(index) - wanted);

          if (distance < nearest) {
            nearest = distance;
            to = index;
          }
        }

        return { ...current, blocked, dy: bounded, started: true, to };
      });
    };

    const onUp = () => {
      const current = dragRef.current;

      if (!current?.started) {
        setDrag(null);

        return;
      }

      meta.suppressed = true;
      // Let go past the edge and the row goes back where it was, with the
      // reason said once in words; the chip on the row was the short form.
      const refused = current.blocked && current.reason !== null;
      const to = refused ? current.from : current.to;
      // Ease the dragged row the rest of the way into its slot (the others are
      // already shifted to receive it), then commit so the swap has no snap.
      const start = meta.rows[current.from];
      const slot = meta.rows[to];
      let settle = 0;

      if (start && slot) {
        settle =
          (to <= current.from ? slot.top : slot.top + slot.height - start.height) - start.top;
      }

      setDrag({ ...current, dy: settle, settling: true, to });
      window.setTimeout(() => {
        if (refused) {
          st.notify(refusedDrop(current.title, meta.parent, meta.siblings));
        } else if (to !== current.from) {
          // Landing at `to` means going just after the row now there when
          // moving down, and just before it when moving up.
          const [, last] = current.span ?? [0, meta.rows.length - 1];

          const before =
            to > current.from
              ? to + 1 <= last
                ? (meta.rows[to + 1]?.title ?? null)
                : null
              : (meta.rows[to]?.title ?? null);

          st.reorderAmong(current.title, before, meta.siblings);
        }

        st.setDragFolded(new Set());
        setDrag(null);
        window.setTimeout(() => {
          meta.suppressed = false;
        }, 0);
      }, 190);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  // A lineage rail folds the rows around the dragged one as the drag starts,
  // so every position taken at the press is stale. Measure again once the
  // fold has laid out, and move the origin by however far the row itself
  // travelled in the fold, so it stays under the pointer.
  useLayoutEffect(() => {
    if (!drag?.started || drag.measured) return;
    const meta = dragMeta.current;
    const list = listRef.current;
    const scroller = list?.parentElement;

    if (!meta || !list || !scroller) return;
    const items = [...list.querySelectorAll<HTMLLIElement>("li[data-title]")];

    const rows = items.map((item) => ({
      height: item.offsetHeight,
      mid: item.offsetTop + item.offsetHeight / 2,
      title: item.dataset.title ?? "",
      top: item.offsetTop,
    }));

    const from = rows.findIndex((entry) => entry.title === drag.title);
    const row = rows[from];
    const item = items[from];

    if (!row || !item) return;
    meta.startY -= meta.oldTop - row.top;
    meta.rows = rows;
    const view = scroller.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    meta.minDy = view.top - rect.top;
    meta.maxDy = view.bottom - rect.bottom;

    const indices = meta.siblings
      .map((sibling) => rows.findIndex((entry) => entry.title === sibling))
      .filter((index) => index !== -1);

    const span: [number, number] | null = indices.length
      ? [Math.min(...indices), Math.max(...indices)]
      : null;

    setDrag((current) =>
      current && !current.measured
        ? { ...current, from, height: row.height, measured: true, span, to: from }
        : current,
    );
  }, [drag?.started, drag?.measured, drag?.title]);

  /**
   * Why a drop went back, in words. The chip on the row said it while the
   * row was being pushed; this is the version with the way forward in it.
   */
  const refusedDrop = (
    title: string,
    parent: string | null,
    siblings: readonly string[],
  ): Parameters<typeof st.notify>[0] => {
    const name = st.displayName(title);
    const family = parent === null ? null : st.displayName(parent);
    const only = siblings.length < 2;

    return {
      note:
        family === null
          ? `${name} is the only direction at the top level; its variants travel with it.`
          : only
            ? `Nothing to reorder it among. Drag ${family} to move the whole family.`
            : `Where a direction sits comes from what it was based on. Drag ${family} to move the whole family.`,
      kind: "reorder",
      message:
        family === null
          ? "Nothing to reorder"
          : only
            ? `${name} is ${family}'s only variant`
            : `${name} stays under ${family}`,
      tone: "info",
      ttl: TOAST_TTL.action,
    };
  };

  // Escape and outside clicks close the popover; focus moves in on open and
  // returns to the button on close. Clicking into a preview blurs the window,
  // which also closes it.
  useEffect(() => {
    if (!widgetOpen) return;
    popoverRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWidgetOpen(false);
        widgetButtonRef.current?.focus();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (!popoverRef.current?.contains(target) && !widgetButtonRef.current?.contains(target)) {
        setWidgetOpen(false);
      }
    };

    const onWindowBlur = () => setWidgetOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [widgetOpen]);

  // Kept on one line. A label that wraps inside a fixed-height row centres its
  // two lines and overflows, which looks like damage rather than a long label,
  // and how close any of them sit to wrapping depends on the interface face
  // the user picked.
  const activeFont = FONTS.find((font) => font.key === st.prefs.font) ?? FONTS[0];
  const framed = st.prefs.viewport !== null;
  /** The `p-6` breathing room a framed preset sits in, both sides. */
  const FRAME_GUTTER = 48;
  const dragging = drag?.started ?? false;

  const [stillMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  /**
   * The light running down the traced line, measured from the marks the rail
   * actually drew rather than worked out again from the layout constants: the
   * two cannot then disagree, and a rail that reflows for a rename or a new
   * width is measured again rather than left drawing where the marks were.
   *
   * Not while dragging. The rail folds under the hand and rows move away from
   * where they were measured, and a light chasing them is noise on top of a
   * gesture that has the user's whole attention.
   */
  type TrailShape = { d: string; height: number; marks: TrailMark[] };

  /**
   * The light on stage and, for a moment, the one it replaced: a change of
   * lineage fades the old light out while the new one fades in, both on the
   * same clock, so the current reroutes instead of restarting.
   */
  const [trail, setTrail] = useState<TrailShape | null>(null);
  /** Every light still fading out, each dropped once its fade is done. */
  const [leaving, setLeaving] = useState<readonly TrailShape[]>([]);
  const traceEdges = litTree.edges;
  const trailKey = `${traceEdges.map((edge) => edge.join(">")).join(",")}|${dragging}|${st.prefs.width}|${gutter}`;

  const replaceTrail = (next: TrailShape | null) =>
    setTrail((current) => {
      if (current?.d === next?.d) return current;

      if (current !== null) {
        const going = current;
        setLeaving((rest) => [...rest.filter((entry) => entry.d !== going.d), going]);
        setTimeout(() => setLeaving((rest) => rest.filter((entry) => entry !== going)), 460);
      }

      return next;
    });

  useLayoutEffect(() => {
    const list = listRef.current;

    if (dragging || list === null || traceEdges.length === 0) {
      replaceTrail(null);

      return;
    }

    const measure = () => {
      const box = list.getBoundingClientRect();
      const at = new Map<string, TrailMark>();
      // Found by reading each row's own title rather than by selector: a
      // title is a name someone typed, and CSS.escape prepares an identifier,
      // not the inside of a quoted attribute match, so a direction whose name
      // begins with a digit would never be found and the light would just not
      // appear.
      const rows = [...list.querySelectorAll<HTMLElement>("li[data-title]")];

      for (const title of litTree.nodes) {
        const row = rows.find((entry) => entry.dataset.title === title);
        const mark = row?.querySelector("[data-mark]");

        if (!row || !mark) return replaceTrail(null);
        const dot = mark.getBoundingClientRect();
        // The room the light leaves around the mark: a dot's radius and a
        // little air, more for the ring on the row on stage, none for a hair
        // tick, which sits in the line.
        const radius = Number(mark.getAttribute("r") ?? 0);
        const ring = title === st.active ? 3.75 : 0;
        at.set(title, {
          clear: ring > 0 || radius > 1.5 ? radius + 2 + ring : 0,
          x: dot.left + dot.width / 2 - box.left,
          y: dot.top + dot.height / 2 - row.getBoundingClientRect().top + row.offsetTop,
        });
      }

      // Every edge is its own subpath, so a tree with forks is one path the
      // light can run down and split along.
      const d = traceEdges
        .map(([parent, child]) =>
          trailPath([at.get(parent) as TrailMark, at.get(child) as TrailMark]),
        )
        .join(" ");

      replaceTrail({ d, height: list.scrollHeight, marks: [...at.values()] });
    };

    measure();
    // Row heights answer to the rail's width, to a rename, and to a note
    // wrapping onto another line, none of which this effect would otherwise
    // hear about.
    const observer = new ResizeObserver(measure);
    observer.observe(list);

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, trailKey]);
  // Dragging the widget counts as busy too: a preview that keeps taking the
  // pointer lights up its own hover states under a drag that is not for it.
  const busy = st.resizing || dragging || widgetDragging;

  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const [reloadTick, setReloadTick] = useState<Record<string, number>>({});

  // Flipping shows a difference over time; a split shows it at once, which is
  // what you want for the last two directions still in contention.
  // A comparison share opens as the comparison: the pair the sharer had on
  // stage, side by side, before the viewer touches anything.
  const [split, setSplit] = useState(viewer?.scope === "compare");
  const [comparePin, setComparePin] = useState<string | null>(viewer?.layout.compare ?? null);

  // A pushed share moves the stage with it, settled while rendering so the
  // frame never shows the old pair first.
  const viewerStage =
    viewer === undefined ? null : `${viewer.scope}\u0001${viewer.layout.compare ?? ""}`;

  const [seenStage, setSeenStage] = useState(viewerStage);

  if (viewerStage !== seenStage) {
    setSeenStage(viewerStage);

    if (viewer !== undefined) {
      setSplit(viewer.scope === "compare");
      setComparePin(viewer.layout.compare);
    }
  }

  const previousRef = useRef<string | null>(null);
  useEffect(() => {
    // Cleanup runs just before the next change, so this holds the direction
    // looked at before the current one.
    return () => {
      previousRef.current = st.active;
    };
  }, [st.active]);

  splitRef.current = () => {
    if (!split && compare !== null) setComparePin(compare);

    if (compare !== null || split) setSplit((current) => !current);
  };

  const compare = nextCompare({
    active: st.active,
    previous: previousRef.current,
    pinned: comparePin,
    parent: st.parentOf(st.active),
    rows: st.rows,
  });

  const visible = paneTitles({ active: st.active, compare, split });
  /** Where each direction on the stage sits, left to right. */
  const stagePlace = new Map(visible.map((title, index) => [title, index]));
  const splitting = visible.length > 1;
  // Keep only the visible stage alive. An exported app can carry a full client
  // runtime, so retaining every previously opened direction multiplies both
  // memory and network work while offering no visible benefit.
  const mounted = visible;
  const previousMounted = useRef(new Map<string, string>());

  const paneIdentityFor = (title: string) =>
    previewIdentity(title, st.urlFor(title), reloadTick[title] ?? 0);

  const paneLoaded = (title: string) => {
    const identity = paneIdentityFor(title);

    return previousMounted.current.get(title) === identity && st.isLoaded(title, identity);
  };

  /**
   * A branch pane on stage is a request to bring that branch up.
   *
   * Opening it is the whole trigger: nothing checks out until somebody looks,
   * which is the point of the change. Asking again while one is in flight is
   * free, because the server joins the start rather than checking out twice,
   * so this can stay a plain effect over whatever is mounted.
   */
  const branchesOnStage = mounted
    .filter((title) => st.branchState(title)?.status === "idle")
    .join("\u0001");

  useEffect(() => {
    for (const title of branchesOnStage.split("\u0001").filter(Boolean)) st.startBranch(title);
    // st is rebuilt every render; the titles are what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesOnStage]);

  const mountedIdentities = new Map(mounted.map((title) => [title, paneIdentityFor(title)]));
  const mountedIdentityKey = [...mountedIdentities.values()].join("\u0001");
  const currentPaneIdentities = useRef(mountedIdentities);
  currentPaneIdentities.current = mountedIdentities;

  // Reset before paint. An ordinary effect lets a reused title draw one frame
  // with its previous loaded state before the skeleton catches up.
  useLayoutEffect(() => {
    const previous = previousMounted.current;

    const changed = [...mountedIdentities].filter(
      ([title, identity]) => previous.get(title) !== identity,
    );

    for (const [title] of changed) st.resetLoaded(title);

    if (changed.some(([title]) => errored[title])) {
      setErrored((current) => {
        const next = { ...current };

        for (const [title] of changed) next[title] = false;

        return next;
      });
    }

    previousMounted.current = new Map(mountedIdentities);
  }, [mountedIdentityKey]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageWatch = useRef<ResizeObserver | null>(null);
  const [stage, setStage] = useState({ height: 0, width: 0 });

  /**
   * Attached as a callback ref rather than measured from an effect. An effect
   * that observes `stageRef.current` once runs before the stage exists on any
   * render that gates it, and an observer that never attached reports a stage
   * of zero forever, which reads downstream as "nothing to scale".
   */
  const attachStage = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    stageWatch.current?.disconnect();

    if (node === null) return;
    // Measured once here as well as observed. A ResizeObserver does not report
    // until the compositor produces a frame, so waiting for it alone leaves the
    // first render believing the stage is nothing and drawing the split
    // unscaled until something else moves.
    const first = node.getBoundingClientRect();
    setStage({ height: first.height, width: first.width });

    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;

      if (box) setStage({ height: box.height, width: box.width });
    });

    observer.observe(node);
    stageWatch.current = observer;
  }, []);

  // Identical for every pane, so it is worked out once. The reasoning lives
  // with the function.
  const {
    boxHeight,
    boxWidth,
    designWidth,
    frameHeight,
    scale: paneScale,
    scaling,
  } = paneGeometry({
    gutter: FRAME_GUTTER,
    panes: visible.length,
    scaleSplit: st.prefs.scaleSplit,
    stageHeight: stage.height,
    stageWidth: stage.width,
    viewport: st.prefs.viewport,
  });

  /**
   * What the active design is actually drawn at, for the capture that rides
   * with a request. A preset is that preset. Otherwise the stage's own width
   * is what a lone pane gets, and a split gives each pane half of it, unless
   * the split is scaled, in which case the design keeps its own width and
   * only the frame shrinks. Null until the stage has been measured; the
   * server picks a sensible default then.
   */
  const drawnWidth =
    st.prefs.viewport !== null
      ? Math.round(st.prefs.viewport)
      : stage.width <= 0
        ? null
        : Math.round(splitting && !scaling ? (stage.width - 1) / 2 : stage.width);

  const widgetAnchor = widgetDrag
    ? (() => {
        const { x, y } = dragAnchor(widgetDrag);

        return { bottom: "auto", left: x, right: "auto", top: y } as const;
      })()
    : undefined;

  const onWidgetPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const stage = stageRef.current?.getBoundingClientRect();

    if (!stage) return;
    // Pointer capture routes every move back here even while the pointer is
    // over a preview. Without it the iframe, being its own document, takes the
    // events and the widget freezes the moment it crosses a design. The rail's
    // resize handle solves the same problem the same way.
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    widgetClickSuppressed.current = false;
    // A tap is never perfectly still, so the widget only starts following the
    // pointer once it has travelled far enough to mean it. Below that it stays
    // put and the click through to the button survives.
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;

    const onMove = (move: PointerEvent) => {
      if (!moved && !isDrag(origin, { x: move.clientX, y: move.clientY })) return;
      moved = true;
      setWidgetDrag(
        clampWidget(
          { x: move.clientX - stage.left, y: move.clientY - stage.top },
          { width: stage.width, height: stage.height },
        ),
      );
    };

    const onUp = (up: PointerEvent) => {
      if (handle.hasPointerCapture(up.pointerId)) handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setWidgetDrag(null);

      if (!moved) return;
      widgetClickSuppressed.current = true;

      // A drag settles into a corner rather than staying wherever it was let
      // go, so it never sits over the middle of a design being judged.
      const { corner } = nearestCorner(
        { x: up.clientX - stage.left, y: up.clientY - stage.top },
        { width: stage.width, height: stage.height },
      );

      st.setPrefs((current) => ({ ...current, corner }));
      setWidgetOpen(false);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  /**
   * Restarting a dev server is routine, so the interface watches for it.
   *
   * Without this, an outage is discovered one pane at a time after a fifteen
   * second timeout, nothing retries when the server returns, and panes that
   * loaded before it died keep presenting a stale render as if it were
   * current. That last one is the worst: the tool quietly showing something
   * untrue.
   */
  const [health, setHealth] = useState<HealthState>(INITIAL_HEALTH);
  // Which panes actually render through that server, and whether any do. In a
  // workspace of file and branch previews nothing on screen depends on it, so
  // "localhost:3000 is down" is not news about anything the user is looking
  // at, and the outage UI has no business appearing.
  //
  // A fresh Set every render, and deliberately absent from the deps of the
  // effects that read it: listed, it would fire them on every render. Each
  // effect runs with the closure of the render that triggered it, so the set
  // is current whenever it is actually read.
  const appPanes = new Set(previews.filter(needsDevServer).map((preview) => preview.title));
  const needsApp = appPanes.size > 0;

  const [requestSnapshot, setRequestSnapshot] = useState<{
    requests: RequestStatus[];
    agent: AgentStatus;
  }>({ requests: [], agent: IDLE_AGENT });

  /**
   * The notes left on every direction, and whether the preview is currently
   * taking new ones.
   *
   * Annotating is a mode rather than an always-live click target because the
   * thing under the pointer is a running application: reaching the state worth
   * annotating usually means clicking through the app first. A mode that has
   * to be asked for is also a mode that cannot be entered by accident, which
   * matters when the alternative is swallowing a click meant for a button.
   */
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [annotating, setAnnotating] = useState(false);
  const [agentState, setAgentState] = useState<AgentsPayload>(EMPTY_AGENTS);
  const [agentsTick, refreshAgents] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (viewing) return;
    let cancelled = false;
    void readAgents(agentsTick > 0)
      .then((payload) => {
        if (cancelled) return;
        setAgentState((current) =>
          JSON.stringify(current) === JSON.stringify(payload) ? current : payload,
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [agentsTick, viewing]);
  // Bumped after a submit so the hint updates without waiting out the
  // interval; the effect restarting is the immediate poll.
  const [requestsTick, bumpRequests] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    // Guard per effect run, like the health poll below: a shared flag would be
    // reset by a remount while the torn-down run's fetch is still in flight,
    // and that response must not land.
    // None of this is served to a viewer, and none of it is theirs to see.
    if (viewing) return;
    let cancelled = false;

    const poll = async (signal: AbortSignal) => {
      const signalled: NoteFetcher = (input, init) => fetch(input, { ...init, signal });
      await fetch("/leglas/api/requests", { signal })
        .then(
          (response) =>
            response.json() as Promise<{ requests: RequestStatus[]; agent?: AgentStatus }>,
        )
        .then((payload) => {
          if (cancelled) return;

          const next = {
            requests: payload.requests,
            agent: payload.agent ?? IDLE_AGENT,
          };

          setRequestSnapshot((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
        })
        // Caught per read rather than around the pair: these are two reads on
        // one beat, and one of them failing is no reason to skip the other.
        .catch(() => {});
      // Read on the same beat as the queue, because the two move together: a
      // change made in place forgets the notes it answered, and a poll that
      // only watched the queue would leave pins on a design that no longer
      // has the problem they describe. After it rather than beside it, so the
      // beat costs one socket instead of two and the previews keep the rest;
      // both are local JSON, so the extra round trip is not a visible one.
      await readNotes(signalled)
        .then((fresh) => {
          if (cancelled) return;
          setNotes((current) =>
            JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh,
          );
        })
        .catch(() => {});
    };

    // One nudge drives both reads, which is what keeps them a pair. The
    // wire has three kinds and annotations is deliberately not one of them,
    // so there is no way to ask for the notes without the queue and no way
    // for a later change to quietly split this beat into two channels.
    const stop = startPoll(poll, {
      everyMs: FALLBACK_MS,
      subscribe: (run) => liveConnection().on("requests", run),
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [requestsTick, viewing]);
  // Two independent readings of one snapshot: the chip says who Enter sends
  // to, the card says what is happening right now. They used to fight over a
  // single footer slot, which is how a running request could hide the chooser.
  const chip = composerAgent(agentState.choice, agentState.agents, agentState.customRun);
  // Focus on the composer is the first honest sign a request is coming, and
  // the seconds spent typing it are where the agent's start-up cost hides.
  // Nothing is warmed before this: a saved choice is not a request.
  const lastWarmAsk = useRef(0);

  const warmChosenAgent = () => {
    if (chip.kind !== "chosen") return;
    const now = Date.now();

    if (now - lastWarmAsk.current < WARM_THROTTLE_MS) return;
    lastWarmAsk.current = now;
    void warmAgent().catch(() => {
      // Only latency is lost; the request itself warms the agent on the way.
    });
  };

  const selectedAgent =
    chip.kind === "chosen"
      ? agentState.agents.find((agent) => agent.id === chip.id && agent.available)
      : undefined;

  const selectedEffort =
    agentState.effort !== null && selectedAgent?.efforts.includes(agentState.effort)
      ? agentState.effort
      : null;

  /**
   * Where the direction being changed came from, said without being asked.
   *
   * The rail keeps this on hover, which is right for the rows being browsed.
   * The one in the composer's sights is different: what it was built from and
   * what was last asked of it are what decide the next thing typed, so it
   * carries the line whether or not anyone thinks to hover.
   */
  /** The notes waiting on the direction the composer is aimed at. */
  const activeNotes = st.active === null ? [] : notes.filter((note) => note.title === st.active);

  const activeOrigin = (() => {
    const origin = provenanceOf(st.active === null ? undefined : st.previewFor(st.active));

    if (origin === null) return null;

    return provenanceLine(
      origin.basedOn === null ? null : st.displayName(origin.basedOn),
      origin.askedFor,
    );
  })();

  /** The selected direction's ancestry, for the rail that draws it as a path. */
  const activeChain = st.active === "" ? [] : st.ancestryOf(st.active);

  const chosenSignedOut =
    chip.kind === "chosen" &&
    agentState.agents.some((agent) => agent.id === chip.id && agent.auth === "signed-out");

  const card = requestCard(
    requestSnapshot.requests,
    requestSnapshot.agent,
    chip.kind === "chosen" || requestSnapshot.agent.attached,
  );

  useEffect(() => {
    if (chip.kind === "none") setAgentMenuOpen(false);
  }, [chip.kind]);
  // Same dismissal contract as the tools popover: Escape, clicking away, or
  // the window losing focus all put the menu back without ceremony.
  useEffect(() => {
    if (!agentMenuOpen) return;
    agentMenuRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgentMenuOpen(false);
        agentTriggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (!agentMenuRef.current?.contains(target) && !agentTriggerRef.current?.contains(target)) {
        setAgentMenuOpen(false);
      }
    };

    const onWindowBlur = () => setAgentMenuOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [agentMenuOpen]);

  const pickAgent = (agent: string) => {
    if (pickingAgent !== null || savingEffort) return;
    const name = agentState.agents.find((option) => option.id === agent)?.name ?? "Agent";
    setPickingAgent(agent);
    void chooseAgent(agent)
      .then(() => {
        refreshAgents();
        setAgentMenuOpen(false);
      })
      .catch(async () => {
        try {
          const current = await readAgents(true);
          setAgentState(current);

          if (current.choice === agent) {
            setAgentMenuOpen(false);

            return;
          }
        } catch {
          // The original error is more useful than a failed recovery read.
        }

        st.notify({
          kind: "agent-choice",
          message: `${name} wasn’t selected. Try again.`,
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setPickingAgent(null));
  };

  const pickEffort = (effort: AgentEffort | null) => {
    if (selectedAgent === undefined || savingEffort || pickingAgent !== null) return;
    const previous = agentState.effort;
    setSavingEffort(true);
    setAgentState((current) => ({ ...current, effort }));
    void chooseAgentEffort(selectedAgent.id, effort)
      .then(() => refreshAgents())
      .catch(() => {
        setAgentState((current) => ({ ...current, effort: previous }));
        st.notify({
          kind: "agent-choice",
          message: "Effort could not be saved. Agent settings did not change.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setSavingEffort(false));
  };

  const cancelRequest = (id: string | null) => {
    if (requestAction !== null) return;
    setRequestAction("cancel");
    void cancelAgentRun(id)
      .then(() => bumpRequests())
      .catch(() => {
        st.notify({
          kind: "agent-cancel",
          message: "Leglas could not stop that run.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setRequestAction(null));
  };

  const retryRequest = (id: string) => {
    if (requestAction !== null) return;
    setRequestAction("retry");
    void retryFailedRequest(id)
      .then(() => bumpRequests())
      .catch(() => {
        st.notify({
          kind: "agent-retry",
          message: "That change could not be retried.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setRequestAction(null));
  };

  const dismissRequest = (id: string) => {
    if (requestAction !== null) return;
    setRequestAction("dismiss");
    void dismissFailedRequest(id)
      .then(() => bumpRequests())
      .catch(() => {
        st.notify({
          kind: "agent-dismiss",
          message: "That change could not be dismissed.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setRequestAction(null));
  };

  useEffect(() => {
    let cancelled = false;

    const poll = (signal: AbortSignal) =>
      fetch("/leglas/api/health", { signal })
        .then((response) => response.json() as Promise<{ reachable: boolean }>)
        .then(({ reachable }) => {
          if (!cancelled) setHealth((current) => nextHealthState(current, reachable));
        })
        .catch(() => {
          // Leglas itself is unreachable; that is not the dev server's fault
          // and the page will fail visibly enough on its own.
        });

    // The server probes the dev server once for every interface rather than
    // each of them probing separately, and says so only when the answer
    // changes. A restart is still noticed in the same beat it always was.
    const stop = startPoll(poll, {
      everyMs: FALLBACK_MS,
      subscribe: (run) => liveConnection().on("health", run),
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Once it answers again, reload what broke rather than making the user click
  // through every pane. Only the panes that went down with it: a file preview
  // kept rendering through the outage, and flashing it back to a skeleton
  // would claim it broke when it did not.
  useEffect(() => {
    if (!health.reachable || !health.wasDown) return;
    setErrored((current) => {
      const next = { ...current };

      for (const title of Object.keys(next)) {
        if (appPanes.has(title)) next[title] = false;
      }

      return next;
    });
    setReloadTick((current) => {
      const next = { ...current };

      // Every app-backed pane, not only the ones that ever reported loaded.
      // A pane whose first navigation failed never reported anything, so
      // keying off that skipped exactly the pane most in need of a remount:
      // the line above clears its error, and without this it sits there
      // showing the dead page with nothing left to say it is broken.
      for (const title of appPanes) {
        next[title] = (next[title] ?? 0) + 1;
      }

      return next;
    });
    setHealth((current) => ({ ...current, wasDown: false }));
  }, [health.reachable, health.wasDown]);

  // A declared URL can silently lie: a typo the app ignores serves the default
  // page, so two directions draw the same thing and the comparison is empty.
  // Read from what each pane actually rendered, which is the claim being made
  // on screen and the only thing that works for a client-rendered app.
  const [scans, setScans] = useState<Record<string, PreviewScan>>({});

  // A background read costs a full boot of the app, so it does not happen in
  // a tab nobody is looking at. Hiding the tab mid-read drops the frame; the
  // direction is read again on return.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);

    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // A pane replaced in place invalidates its background verdict before the
  // new document paints. URL changes are also rejected by scanSignatures, but
  // an explicit retry of the same URL needs this generation-aware reset. A
  // direction merely coming on stage keeps its verdict: it is the document
  // the background read already measured.
  //
  // Every direction is tracked, not only the ones on stage. A dev server
  // coming back reloads every app-backed direction, most of which are off
  // stage; with only mounted titles remembered, those had no previous
  // identity to differ from, so the change was missed and a restart that
  // altered the page could still be called a duplicate of what it used to be.
  const scanIdentities = new Map(
    previews.map((preview) => [preview.title, paneIdentityFor(preview.title)]),
  );

  const scanIdentityKey = [...scanIdentities]
    .map(([title, identity]) => `${title}${identity}`)
    .join("");

  const previousScanPanes = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const changed = replacedPanes(previousScanPanes.current, scanIdentities);

    if (changed.length > 0) setScans((current) => forgetScans(current, changed));
    previousScanPanes.current = new Map(scanIdentities);
  }, [scanIdentityKey]);

  /**
   * Hide the framework's own dev badge inside a preview.
   *
   * Next and others paint a floating indicator over the running app. It is
   * tooling rather than design, it lands on top of the corner being judged,
   * and with two panes open it is two badges.
   *
   * Error overlays are deliberately left alone. Next renders its badge and its
   * error modals into one `nextjs-portal` element, so hiding the host would
   * suppress every compilation and runtime error it reports, leaving a stale
   * or blank preview looking healthy. Its shadow root is open and the badge is
   * one identifiable child, so this reaches in for that child alone.
   *
   * Injected into the frame rather than rewritten into the proxied response,
   * deliberately: the bytes Leglas forwards stay exactly what the dev server
   * sent, so this is a viewing preference and never a change to the app.
   */
  const applyOverlayPref = (frame: HTMLIFrameElement, hide: boolean) => {
    let doc: Document | null = null;

    try {
      doc = frame.contentDocument;
    } catch {
      return;
    }

    if (!doc?.head) return;

    const ID = "leglas-hide-dev-overlays";

    // `find` and `into` differ: a style is looked up on the document but has to
    // be appended to its head, because a Document may hold only one element.
    const put = (find: Document | ShadowRoot, into: Node, css: string) => {
      const existing = find.getElementById(ID);

      if (!hide) {
        existing?.remove();

        return;
      }

      if (existing) return;
      const style = (doc as Document).createElement("style");
      style.id = ID;
      style.textContent = css;
      into.appendChild(style);
    };

    put(doc, doc.head, BADGE_CSS);

    for (const portal of doc.querySelectorAll("nextjs-portal")) {
      const root = portal.shadowRoot;

      if (root) put(root, root, NEXT_BADGE_CSS);
    }
  };

  /**
   * Re-apply to every frame after each render.
   *
   * Doing this only on load is not enough: a fresh iframe fires load for its
   * initial about:blank document before navigating to its real src, so the
   * style lands in a document that is then thrown away. That is why a real
   * Next badge stayed visible while the preference said otherwise.
   *
   * The work is idempotent and skips a frame that already has the style, so
   * running it on every render costs a lookup per pane and removes the
   * dependence on catching one particular event.
   */
  useEffect(() => {
    for (const frame of document.querySelectorAll("iframe")) {
      applyOverlayPref(frame as HTMLIFrameElement, !st.prefs.showDevOverlays);
    }
  });

  const readRendered = (frame: HTMLIFrameElement): string | null | undefined => {
    // Cross-origin panes are unreadable by design; a branch preview or a
    // deployed URL simply goes uncompared.
    let doc: Document | null = null;

    try {
      doc = frame.contentDocument;
    } catch {
      return undefined;
    }

    if (!doc?.body) return undefined;

    const tags = [...doc.body.querySelectorAll("*")]
      .slice(0, 400)
      .map((element) => element.tagName);

    const view = doc.defaultView;

    const paint = view
      ? paintSample(doc.body, (element) => {
          const style = view.getComputedStyle(element as Element);

          return {
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            color: style.color,
          };
        })
      : [];

    const visual = view
      ? visualSample(doc.body, (element, pseudo) => view.getComputedStyle(element, pseudo))
      : [];

    return renderedSignature(doc.body.innerText ?? "", tags, paint, visual);
  };

  /**
   * Fingerprinting hundreds of computed styles is intentionally deferred until
   * the preview has painted and the browser has idle time. Waiting briefly for
   * fonts avoids recording a transient fallback-font layout, while a deadline
   * keeps one slow font request from stalling the duplicate scan.
   */
  const scheduleRenderedRead = (
    frame: HTMLIFrameElement,
    onRead: (signature: string | null | undefined) => void,
  ) => {
    let fonts: FontFaceSet | undefined;

    try {
      fonts = frame.contentDocument?.fonts;
    } catch {
      // A cross-origin frame is handled by readRendered.
    }

    const fontDeadline = new Promise<void>((resolve) => window.setTimeout(resolve, 900));

    const fontsReady =
      fonts?.status === "loading"
        ? Promise.race([fonts.ready.then(() => undefined), fontDeadline])
        : Promise.resolve();

    void fontsReady.then(() => {
      const run = () => {
        applyOverlayPref(frame, !st.prefs.showDevOverlays);
        onRead(readRendered(frame));
      };

      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 1_200 });
      } else {
        window.setTimeout(run, 0);
      }
    });
  };

  const readyDocuments = useRef(new WeakSet<Document>());

  /** Commit a successful navigation once for each real iframe document. */
  const markPreviewReady = (title: string, identity: string, frame: HTMLIFrameElement) => {
    if (currentPaneIdentities.current.get(title) !== identity) return;
    st.markLoaded(title, identity);
    setErrored((current) => (current[title] ? { ...current, [title]: false } : current));

    applyOverlayPref(frame, !st.prefs.showDevOverlays);

    let doc: Document | null = null;

    try {
      doc = frame.contentDocument;
    } catch {
      // Cross-origin previews have no signature to invalidate.
    }

    if (doc === null || readyDocuments.current.has(doc)) return;
    readyDocuments.current.add(doc);
  };

  const markPreviewReadyRef = useRef(markPreviewReady);
  markPreviewReadyRef.current = markPreviewReady;

  useEffect(() => {
    const onPreviewMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      const signal = previewMessageSignal(event.data);

      if (signal === null) return;

      const frame = previewFrameForSource(
        document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]"),
        event.source,
      );

      const title = frame?.dataset.preview;
      const identity = frame?.dataset.previewIdentity;

      if (frame === null || title === undefined || identity === undefined) return;

      if (signal === "ready") {
        markPreviewReadyRef.current(title, identity, frame);
      } else {
        setErrored((current) => ({ ...current, [title]: true }));
      }
    };

    window.addEventListener("message", onPreviewMessage);

    return () => window.removeEventListener("message", onPreviewMessage);
  }, []);

  /**
   * The duplicate check without waiting for clicks.
   *
   * Signatures used to come only from panes the user had opened, so "Same as"
   * appeared one click at a time, after the judgment it exists to protect.
   * Every same-origin preview is read here: one hidden off-stage frame walks
   * them sequentially at a fixed size, records each signature, and unmounts.
   * One at a time keeps the cost to a single extra app instance, briefly, per
   * direction while ensuring stage dimensions never affect the verdict.
   *
   * The frame is parked off-viewport rather than display:none, because a
   * hidden document lays out nothing and reads as empty. Proxied previews
   * queue only while the dev server answers — scanning a down server would
   * record N failures — but a preview Leglas serves itself never went down,
   * so those scan regardless.
   */
  const scannable =
    scanPreviews && !viewing
      ? health.reachable
        ? previews
        : previews.filter((preview) => !needsDevServer(preview))
      : [];

  const changingTitles = changingRequestTitles(requestSnapshot.requests);
  const changingTitlesKey = changingTitles.toSorted().join("\u0000");
  const scanBlocked = requestSnapshot.agent.running || changingTitles.length > 0;
  const workingTitles = workingRequestTitles(requestSnapshot.requests);
  const notesSent = notesAwaitingChange(requestSnapshot.requests);

  // A result recorded before an edit began must not reappear when the queue
  // settles. Clear the directions being edited once per live-work transition,
  // while also hiding them synchronously in the render that first reports the
  // work. Only those: a run with no direction named against it, which the
  // queue poll can show for a beat between one request ending and the next,
  // used to clear every verdict and read the whole rail again.
  useEffect(() => {
    if (changingTitles.length === 0) return;
    setScans((current) => forgetScans(current, changingTitles));
  }, [changingTitlesKey]);

  const visibleReady = mounted.every((title) => paneLoaded(title));
  const scansForDisplay = changingTitles.length > 0 ? forgetScans(scans, changingTitles) : scans;
  const signatures = scanSignatures(previews, scansForDisplay);
  const twins = twinsOf(signatures);

  const scanningPreview =
    !scanBlocked && visibleReady && pageVisible
      ? (scanQueue(scannable, scansForDisplay)[0] ?? null)
      : null;

  const scanning = scanningPreview?.title ?? null;

  const scanKey =
    scanningPreview === null ? null : `${scanningPreview.title}\u0000${scanningPreview.url}`;

  const activeScan = useRef(scanKey);
  activeScan.current = scanKey;
  const activeScanFrame = useRef<HTMLIFrameElement | null>(null);

  const currentPreviewUrls = useRef(
    new Map(previews.map((preview) => [preview.title, preview.url])),
  );

  currentPreviewUrls.current = new Map(previews.map((preview) => [preview.title, preview.url]));

  const finishScan = (preview: Preview, outcome: PreviewScanOutcome, frame: HTMLIFrameElement) => {
    const expected = `${preview.title}\u0000${preview.url}`;

    if (activeScan.current !== expected) return;

    if (activeScanFrame.current !== frame) return;

    if (currentPreviewUrls.current.get(preview.title) !== preview.url) return;
    setScans((current) => recordScan(current, preview, outcome));
  };

  // A hung navigation is a failed check, not an empty but valid signature.
  useEffect(() => {
    if (scanningPreview === null) return;
    const frame = activeScanFrame.current;

    if (frame === null) return;

    const timer = window.setTimeout(() => {
      finishScan(scanningPreview, { status: "failed" }, frame);
    }, LOAD_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [scanKey]);

  const onScanLoad = (preview: Preview, frame: HTMLIFrameElement) => {
    // A fresh iframe fires load for about:blank before the real navigation.
    // The visible watcher rejects it, and the background scanner must too.
    if (!previewFrameIsReady(frame)) return;
    // A hidden badge leaves the text, so every canonical read applies the same
    // overlay preference before measuring.
    applyOverlayPref(frame, !st.prefs.showDevOverlays);
    window.setTimeout(() => {
      const expected = `${preview.title}\u0000${preview.url}`;

      if (activeScan.current !== expected) return;
      scheduleRenderedRead(frame, (signature) => {
        finishScan(
          preview,
          signature === undefined ? { status: "failed" } : { status: "complete", signature },
          frame,
        );
      });
    }, 600);
  };

  useEffect(() => {
    const stopWatching: Array<() => void> = [];

    for (const title of mounted) {
      const identity = mountedIdentities.get(title) ?? paneIdentityFor(title);

      if (st.isLoaded(title, identity) || errored[title]) continue;

      const frame = document.querySelector<HTMLIFrameElement>(
        `iframe[data-preview="${CSS.escape(title)}"]`,
      );

      if (frame === null) continue;

      // A known-down dev server needs no waiting, but a file preview is served
      // by Leglas itself and still gets the ordinary navigation window.
      const timeoutMs = health.reachable || !appPanes.has(title) ? LOAD_TIMEOUT_MS : 0;
      stopWatching.push(
        watchPreviewFrame({
          frame,
          onFailure: () => setErrored((current) => ({ ...current, [title]: true })),
          onReady: () => markPreviewReady(title, identity, frame),
          sameOrigin: st.urlFor(title).startsWith("/"),
          timeoutMs,
        }),
      );
    }

    return () => {
      for (const stop of stopWatching) stop();
    };
  }, [mountedIdentityKey, st.loaded, errored, health.reachable]);

  const reloadPane = (title: string) => {
    setErrored((current) => ({ ...current, [title]: false }));
    st.resetLoaded(title);
    setReloadTick((current) => ({ ...current, [title]: (current[title] ?? 0) + 1 }));
  };

  const onRowPointerDown =
    (title: string, index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;

      if (viewing || st.renaming || st.query.trim() || st.rows.length < 2) return;

      // Buttons keep their clicks, and anything marked selectable keeps its
      // selection outright. The note used to be marked that way, which took
      // the bottom half of every row out of the gesture: a press there could
      // only ever paint a highlight, and on a rail of two-line notes that is
      // most of the surface a hand lands on. It is a drag candidate now, and
      // which gesture the press turns out to be is settled by the direction
      // it moves in rather than by where it started.
      if ((event.target as HTMLElement).closest("button, [data-selectable]")) return;
      const list = listRef.current;
      const scroller = list?.parentElement;

      if (!list || !scroller) return;
      const items = [...list.querySelectorAll<HTMLLIElement>("li[data-title]")];

      const rows = items.map((item) => ({
        height: item.offsetHeight,
        mid: item.offsetTop + item.offsetHeight / 2,
        title: item.dataset.title ?? "",
        top: item.offsetTop,
      }));

      const view = scroller.getBoundingClientRect();
      const rowRect = items[index]?.getBoundingClientRect();
      // On a lineage rail a row is ordered among its siblings and nowhere
      // else: its place under its parent is a fact about the design, not a
      // preference. What it can be pushed against is decided here, so the
      // row can say so the moment it is.
      const parent = st.railParents.get(title) ?? null;
      const siblings = parent === null ? st.railRoots : (st.railChildren.get(parent) ?? [title]);

      const reason =
        siblings.length < 2
          ? parent === null
            ? "Nothing to reorder"
            : `${st.displayName(parent)}'s only variant`
          : parent === null
            ? null
            : `Stays under ${st.displayName(parent)}`;

      dragMeta.current = {
        maxDy: rowRect ? view.bottom - rowRect.bottom : 0,
        minDy: rowRect ? view.top - rowRect.top : 0,
        oldTop: rows[index]?.top ?? 0,
        parent,
        rows,
        siblings,
        startX: event.clientX,
        startY: event.clientY,
        suppressed: false,
      };
      const first = rows[0];
      const second = rows[1];
      setDrag({
        blocked: false,
        dy: 0,
        from: index,
        gap: first && second ? second.top - first.top - first.height : 0,
        height: rows[index]?.height ?? 0,
        measured: true,
        reason,
        span: null,
        title,
        settling: false,
        started: false,
        to: index,
      });
    };

  // Rows other than the dragged one make room: down by the dragged row's
  // height when the insertion point passes above them, up when below.
  const shiftFor = (index: number): number => {
    if (!drag?.started) return 0;
    const pitch = drag.height + drag.gap;

    if (index < drag.from && index >= drag.to) return pitch;

    if (index > drag.from && index <= drag.to) return -pitch;

    return 0;
  };

  /** Leaving the mode is all the shell has to know about it. */
  const stopAnnotating = useCallback(() => setAnnotating(false), []);

  // Both of these answer whether the words landed, because the card holding
  // them stays open until they have. A note typed into a field and lost to a
  // failed write is the one thing an annotation must not do.
  const keepNote = (title: string, anchor: Anchor, text: string): Promise<boolean> => {
    // Annotations are a request on their own: the field can stay empty and
    // Send still has something to send. So dropping the first pin is as
    // honest a sign that a request is coming as typing into the composer,
    // and without this that whole path started its agent cold.
    warmChosenAgent();

    return addNote(title, text, anchor)
      .then(() => {
        bumpRequests();

        return true;
      })
      .catch(() => {
        st.notify({
          kind: "request",
          message: "That annotation could not be kept.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });

        return false;
      });
  };

  const reviseNote = (id: string, text: string): Promise<boolean> =>
    updateNote(id, text)
      .then(() => {
        bumpRequests();

        return true;
      })
      .catch(() => {
        st.notify({
          kind: "request",
          message: "That annotation could not be changed.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });

        return false;
      });

  const forgetNote = (id: string) => {
    void deleteNotes([id])
      .then(() => bumpRequests())
      .catch(() => {});
  };

  /**
   * The design by itself in a new tab. A preview URL is the app's own URL, so
   * what opens is the direction filling the window with none of this chrome
   * around it, the closest thing to seeing it shipped.
   */
  const openAlone = (title: string) => {
    window.open(st.urlFor(title), "_blank", "noopener,noreferrer");
  };

  return (
    <main
      className={`flex h-dvh bg-[#1C1C20] text-white antialiased selection:bg-[#E6E8EC] selection:text-[#17181B] ${
        st.resizing ? "cursor-col-resize" : ""
      } ${busy ? "select-none" : ""}`}
      data-leglas-shell=""
      style={{ fontFamily: activeFont.stack }}
    >
      <aside
        className={`relative shrink-0 overflow-hidden border-r border-[#232328] ${
          st.prefs.collapsed ? "" : "shadow-2xl"
        } ${
          st.resizing ? "" : `transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
        }`}
        style={{ width: st.prefs.collapsed ? 48 : st.prefs.width }}
      >
        <div
          className={`flex h-full flex-col transition-opacity duration-150 ${
            st.prefs.collapsed ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
          inert={st.prefs.collapsed}
          style={{ width: st.prefs.width }}
        >
          <RailHeader
            active={st.active}
            compare={splitting ? compare : null}
            displayName={st.displayName}
            notify={st.notify}
            onCollapse={() => st.setPrefs((prefs) => ({ ...prefs, collapsed: true }))}
            prefs={st.prefs}
            previews={previews}
            viewing={viewing}
          />

          {viewer !== undefined && <ViewerBanner scope={viewer.scope} />}

          <Search cap={SEARCH_CAP} inputRef={searchRef} onQuery={st.setQuery} query={st.query} />

          {warnings.length > 0 && (
            <section
              aria-label="Preview warning"
              className="mx-3 mb-1 mt-1 rounded-md border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-2"
            >
              <p className="text-xs font-medium text-amber-300/90">
                Preview may be from another project
              </p>
              {warnings.map((warning) => (
                <p className="mt-0.5 text-[11px] leading-snug text-[#9CA3AF]" key={warning}>
                  {warning}
                </p>
              ))}
            </section>
          )}

          {needsApp && !health.reachable && (
            <div className="mx-3 mb-1 mt-1 rounded-md border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-2">
              <p className="text-xs font-medium text-amber-300/90">Dev server not responding</p>
              <p className="mt-0.5 text-[11px] leading-snug text-[#9CA3AF]">
                Anything on screen is from before it stopped. Previews return on their own once it
                is back.
              </p>
            </div>
          )}

          <div
            className="flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{
              // Lines that run past the viewport fade out rather than being
              // cut, so the lineage reads as running through the rail instead
              // of drawn in a box.
              WebkitMaskImage: RAIL_FADE,
              maskImage: RAIL_FADE,
            }}
          >
            <ul
              className="relative flex flex-col gap-1"
              data-traced={traced ?? ""}
              onPointerLeave={() => {
                setTraced(null);
                setGlow((current) => ({ ...current, on: false }));
              }}
              ref={listRef}
            >
              <div
                aria-hidden
                className={`pointer-events-none absolute right-0 z-0 rounded-md bg-white/[0.06] transition-[transform,height,opacity,left] duration-150 ${EASE} motion-reduce:transition-none`}
                style={{
                  height: glow.height,
                  left: glow.left,
                  opacity: glow.on && !dragging ? 1 : 0,
                  transform: `translateY(${glow.top}px)`,
                }}
              />
              {st.rows.map((title, index) => (
                <RailRow
                  arriving={arriving}
                  comparing={splitting && title === compare}
                  crumbBloom={crumbBloom}
                  drag={drag}
                  dragMeta={dragMeta}
                  dragging={dragging}
                  freshFor={freshFor}
                  gutter={gutter}
                  index={index}
                  insets={insets}
                  key={title}
                  lit={litSegments?.get(title)}
                  onEnter={(row) => {
                    setTraced(title);
                    setGlow(glowFor(row));
                  }}
                  onFold={() => foldFamily(title)}
                  onOpenAlone={() => openAlone(title)}
                  onPointerDown={onRowPointerDown(title, index)}
                  onToggleCompare={() => {
                    if (splitting && title === compare) {
                      setSplit(false);

                      return;
                    }

                    setComparePin(title);
                    setSplit(true);
                  }}
                  same={twins[title]}
                  scanning={scanning === title}
                  shiftFor={shiftFor}
                  st={st}
                  tint={tint}
                  title={title}
                  viewing={viewing}
                  working={workingTitles.has(title)}
                />
              ))}
              {leaving
                .filter((entry) => entry.d !== trail?.d)
                .map((entry) => (
                  <Trail
                    d={entry.d}
                    height={entry.height}
                    key={`leaving:${entry.d}`}
                    leaving
                    marks={entry.marks}
                    still={stillMotion}
                    width={gutter}
                  />
                ))}
              {trail !== null && (
                <Trail
                  d={trail.d}
                  height={trail.height}
                  key={trail.d}
                  marks={trail.marks}
                  still={stillMotion}
                  width={gutter}
                />
              )}
            </ul>

            {st.rows.length === 0 && (
              <div className="px-3 py-2">
                {st.query.trim() ? (
                  <>
                    <p className="text-xs text-[#9CA3AF]">Nothing matches “{st.query}”.</p>
                    <button
                      className="mt-1 rounded text-xs text-[#84848C] underline underline-offset-2 transition-colors hover:text-[#D1D5DB]"
                      onClick={() => st.setQuery("")}
                      type="button"
                    >
                      Clear search
                    </button>
                  </>
                ) : (
                  <p className="text-xs leading-snug text-[#9CA3AF]">
                    {viewing
                      ? "Nothing here was shared."
                      : st.visibleCount === 0 && st.hiddenCount > 0
                        ? "Every direction is removed. Restore one below."
                        : "No directions yet. Add them to leglas.config.ts."}
                  </p>
                )}
              </div>
            )}

            {!viewing && st.hiddenCount > 0 && (
              <div className="mt-1 flex items-center justify-between gap-2">
                <button
                  className="min-w-0 flex-1 rounded px-3 py-1.5 text-left text-[11px] text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                  onClick={() => st.setShowHidden((value) => !value)}
                  type="button"
                >
                  {st.showHidden ? "Hide" : "Show"} removed ({st.hiddenCount})
                </button>
                {st.showHidden ? (
                  <button
                    className="rounded px-3 py-1.5 text-[11px] text-[#9CA3AF] transition-[color,scale] hover:text-red-300 active:scale-[0.96]"
                    onClick={() => setDeletePrompt({ error: null, titles: [...st.prefs.hidden] })}
                    type="button"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
            )}

            {!viewing && st.showHidden && (
              <ul className="relative">
                {st.prefs.hidden.filter(st.matches).map((title) => (
                  <li className="group relative" key={title}>
                    <div className="flex items-center justify-between rounded-md px-3 py-2 transition-colors group-hover:bg-white/[0.04]">
                      <span className="truncate text-sm font-medium text-[#9CA3AF]">
                        {st.displayName(title)}
                      </span>
                      <div className="flex shrink-0 items-center gap-3">
                        <button
                          className="rounded text-[11px] text-[#9CA3AF] transition-colors hover:text-white"
                          onClick={() => {
                            st.restore(title);
                            st.notify({
                              kind: `remove:${title}`,
                              message: `${st.displayName(title)} is back in the list`,
                              tone: "success",
                              ttl: TOAST_TTL.plain,
                            });
                          }}
                          type="button"
                        >
                          Restore
                        </button>
                        <button
                          className="rounded text-[11px] text-[#84848C] transition-[color,scale] hover:text-red-300 active:scale-[0.96]"
                          onClick={() => setDeletePrompt({ error: null, titles: [title] })}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The rail's foot as one measured block, because the card above the
              composer gives it a height that moves and the toasts stack on
              whatever that height turns out to be. */}
          <div ref={railFooterRef}>
            {!viewing && card !== null && (
              <StatusCard
                action={requestAction}
                card={card}
                onCancel={cancelRequest}
                onDismiss={dismissRequest}
                onRetry={retryRequest}
              />
            )}
            {/* Enter both queues the request and copies the prompt, so it works
              whether the agent drains the queue or the prompt gets pasted into
              a chat by hand. The confirmation is a toast rather than the
              placeholder it used to swap in, which vanished with the panel
              that carried it. */}
            {!viewing && (
              <form
                className="relative px-3 pb-2.5 pt-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = intent.trim();
                  const title = st.active;

                  // A note carries its own words and its own address, so pins
                  // alone are a request. Nothing at all still is not.
                  if ((!value && activeNotes.length === 0) || !title || sending) return;
                  const name = st.displayName(title);
                  // An image still uploading lands in a moment; one that failed
                  // needs a decision, because sending without it would quietly
                  // drop the thing that was attached on purpose.
                  const blocker = sendBlocker(references);

                  if (blocker !== null) {
                    st.notify({
                      kind: "request",
                      message:
                        blocker === "uploading"
                          ? "Still uploading an image. Try again in a moment."
                          : "One image did not upload. Retry it or remove it, then send.",
                      tone: "info",
                      ttl: TOAST_TTL.action,
                    });

                    return;
                  }

                  const attached = referenceIds(references);
                  setSending(true);
                  void fetch("/leglas/api/request", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      title,
                      intent: value,
                      mode,
                      // The width the design is drawn at, so the agent sees the
                      // layout being judged rather than a default one.
                      ...(drawnWidth === null ? {} : { width: drawnWidth }),
                      // The other pane, when there is one: "the other one" in the
                      // words typed means it, and the agent should see it too.
                      ...(splitting && compare !== null && compare !== title ? { compare } : {}),
                      ...(attached.length === 0 ? {} : { references: attached }),
                    }),
                  })
                    .then(
                      (response) =>
                        response.json() as Promise<{
                          ok: boolean;
                          prompt?: string;
                          duplicate?: boolean;
                          error?: string;
                        }>,
                    )
                    .then((result) => {
                      // The same words at the same direction, already waiting.
                      // The field keeps them: this is the moment to change the
                      // wording or wait, not to lose what was typed. Anything
                      // else still queues, so the queue keeps being a queue.
                      if (result.duplicate === true) {
                        setSending(false);
                        st.notify({
                          kind: "request",
                          message: `That exact change to ${name} is already queued.`,
                          tone: "info",
                          ttl: TOAST_TTL.action,
                        });

                        return;
                      }

                      // A refusal with a reason (an image pruned while the
                      // composer sat open) keeps the words and the thumbnails:
                      // the reason says what to do with them.
                      if (!result.ok && typeof result.error === "string") {
                        setSending(false);
                        st.notify({
                          kind: "request",
                          message: result.error,
                          tone: "danger",
                          ttl: TOAST_TTL.action,
                        });

                        return;
                      }

                      if (!result.ok || !result.prompt) throw new Error("refused");
                      setIntent("");
                      clearReferences();
                      // The send is over once the queue has the request; the
                      // clipboard is a bonus that must not hold the field. A
                      // browser sitting on a permission prompt never settles its
                      // write either way, and waiting on it here once left the
                      // composer disabled for good.
                      setSending(false);
                      bumpRequests();
                      st.notify({
                        kind: "request",
                        message: `Asked for a change to ${name}.`,
                        tone: "success",
                        ttl: TOAST_TTL.plain,
                      });
                      // The copy then supersedes that line whenever it settles,
                      // since toasts of one kind replace rather than stack.
                      void copyText(result.prompt).then((outcome) => {
                        st.notify({
                          kind: "request",
                          // A blocked clipboard costs nothing here: the request is
                          // already queued, and the command that drains it is the
                          // path the prompt was written for anyway.
                          message:
                            outcome === "copied"
                              ? `Asked for a change to ${name}. Prompt copied.`
                              : `Asked for a change to ${name}. Your browser blocked the clipboard, so read it with npx leglas requests.`,
                          tone: "success",
                          ttl: TOAST_TTL.plain,
                        });
                      });
                    })
                    .catch(() => {
                      setSending(false);
                      st.notify({
                        kind: "request",
                        message: `That request never reached Leglas. ${name} is unchanged.`,
                        tone: "danger",
                        ttl: TOAST_TTL.action,
                      });
                    });
                }}
              >
                {/* One surface, like every composer people already know: what to
                change on top, who runs it and the send below, inside the same
                border. The field takes the focus ring for the whole object. */}
                <div
                  className={`rounded-md border bg-[#2E2E2E]/40 transition-colors ${
                    dropping
                      ? "border-[#7C9CFF]/70 ring-1 ring-[#7C9CFF]/40"
                      : "border-[#232328] focus-within:border-[#D1D5DB]/40 focus-within:ring-1 focus-within:ring-[#D1D5DB]/40"
                  }`}
                  onDragEnter={(event) => {
                    if (!carriesFiles(event.dataTransfer.types)) return;
                    event.preventDefault();
                    dropDepth.current += 1;
                    setDropping(true);
                  }}
                  onDragLeave={(event) => {
                    if (!carriesFiles(event.dataTransfer.types)) return;
                    dropDepth.current = Math.max(0, dropDepth.current - 1);

                    if (dropDepth.current === 0) setDropping(false);
                  }}
                  onDragOver={(event) => {
                    if (!carriesFiles(event.dataTransfer.types)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(event) => {
                    if (!carriesFiles(event.dataTransfer.types)) return;
                    event.preventDefault();
                    dropDepth.current = 0;
                    setDropping(false);
                    // Every dropped file goes through admission, so a PDF or an
                    // SVG is refused with a reason rather than ignored.
                    attachReferences(Array.from(event.dataTransfer.files));
                  }}
                >
                  <ReferenceStrip
                    drafts={references}
                    onRemove={removeReference}
                    onRetry={retryReference}
                  />
                  {/* Enter sends and Shift+Enter breaks the line, the contract
                  every chat composer has already taught. */}
                  <textarea
                    aria-label={
                      st.active
                        ? `Ask your agent to change the ${st.displayName(st.active)} direction`
                        : "Ask your agent to change a direction"
                    }
                    className="block w-full resize-none overflow-y-auto bg-transparent px-2.5 pb-1 pt-2 text-xs leading-4 text-white placeholder:text-[#84848C] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={sending || !st.active}
                    onChange={(event) => {
                      // The first character is a second signal, for a composer
                      // that kept focus across the idle window and never refocused.
                      if (intent === "" && event.target.value !== "") warmChosenAgent();
                      setIntent(event.target.value);
                    }}
                    onFocus={warmChosenAgent}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);

                      if (files.length === 0) return;
                      // A pasted image is the request. The text a browser puts
                      // beside it is a filename nobody typed.
                      event.preventDefault();
                      attachReferences(files);
                    }}
                    placeholder={
                      st.active === null
                        ? "No direction to change yet"
                        : dropping
                          ? "Drop the image here"
                          : references.length > 0 && activeNotes.length === 0
                            ? `Say what to take from the ${
                                references.length === 1 ? "image" : "images"
                              }…`
                            : activeNotes.length > 0
                              ? `Send ${
                                  activeNotes.length === 1
                                    ? "the annotation"
                                    : `${activeNotes.length} annotations`
                                }, or add words…`
                              : `Change ${st.displayName(st.active)}…`
                    }
                    ref={requestRef}
                    rows={1}
                    value={intent}
                  />
                  <div className="flex items-center justify-end gap-1.5 p-1">
                    <ModeChip
                      mode={mode}
                      onToggle={() => setMode(mode === "variant" ? "replace" : "variant")}
                    />
                    <AttachButton
                      count={references.length}
                      disabled={!st.active || sending || references.length >= REFERENCE_CAP}
                      inputRef={referenceInputRef}
                      onFiles={attachReferences}
                    />
                    <AnnotateButton
                      annotating={annotating}
                      count={activeNotes.length}
                      onToggle={() => (annotating ? stopAnnotating() : setAnnotating(true))}
                    />
                    <AgentPicker
                      agents={agentState.agents}
                      chip={chip}
                      chosenSignedOut={chosenSignedOut}
                      connectRef={mcpConnectTriggerRef}
                      menuRef={agentMenuRef}
                      onConnect={() => setMcpConnectOpen(true)}
                      onPick={pickAgent}
                      onPickEffort={pickEffort}
                      onRefresh={refreshAgents}
                      open={agentMenuOpen}
                      pickingAgent={pickingAgent}
                      savingEffort={savingEffort}
                      selectedAgent={selectedAgent}
                      selectedEffort={selectedEffort}
                      setOpen={setAgentMenuOpen}
                      triggerRef={agentTriggerRef}
                    />
                    <SendButton
                      ready={
                        (intent.trim() !== "" || activeNotes.length > 0) &&
                        Boolean(st.active) &&
                        !sending
                      }
                      sending={sending}
                      target={st.active ? st.displayName(st.active) : null}
                    />
                  </div>
                </div>
              </form>
            )}

            {sending ? (
              /* The send takes a second or two now: Leglas loads the direction
               in a headless browser so the agent sees what the user sees. Said
               in words, because a field that goes quiet for two seconds reads
               as a hang. It takes the provenance line's slot rather than
               stacking under it. */
              <div className="px-3 pb-2">
                <p
                  aria-live="polite"
                  className="min-w-0 truncate text-[10px] leading-snug text-[#84848C]"
                >
                  Capturing the design for your agent…
                </p>
              </div>
            ) : activeChain.length > 0 ? (
              <Crumbs
                askedFor={provenanceOf(st.previewFor(st.active))?.askedFor ?? null}
                chain={activeChain}
                displayName={st.displayName}
                onCompare={(title) => {
                  setComparePin(title);
                  setSplit(true);
                }}
                onGo={st.setActive}
                onRail={(title) => st.rows.includes(title)}
                onTrace={traceFromCrumb}
                openAsk
                self={st.active}
                tint={tint}
                traced={traced}
              />
            ) : activeOrigin === null ? null : (
              <div className="px-3 pb-2">
                <p
                  className="min-w-0 truncate text-[10px] leading-snug text-[#84848C]"
                  title={activeOrigin}
                >
                  {activeOrigin}
                </p>
              </div>
            )}
            {/* One quiet line under the composer, and only when it has a job:
              the way back to the hidden tools, or word that a terminal
              watcher is holding the queue. */}
            {!st.prefs.showWidget ? (
              <div className="px-3 pb-2">
                <button
                  className="min-w-0 max-w-full truncate rounded text-left text-[10px] leading-snug text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                  onClick={() => setWidgetOpen(true)}
                  type="button"
                >
                  Bring the tools back <kbd className="font-sans text-[#9CA3AF]">T</kbd>
                </button>
              </div>
            ) : !viewing && requestSnapshot.agent.attached && card === null ? (
              <div className="px-3 pb-2">
                <p className="min-w-0 truncate text-[10px] leading-snug text-[#84848C]">
                  Your agent is listening
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={`absolute inset-y-0 left-0 z-30 flex w-12 flex-col items-center bg-[#1C1C20] py-3 transition-opacity duration-150 ${
            st.prefs.collapsed ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          inert={!st.prefs.collapsed}
        >
          <Mark size={24} />
          <Tip
            label={
              <>
                Open directions <kbd className="ml-1 text-[#9CA3AF]">[</kbd>
              </>
            }
            side="right"
          >
            <button
              aria-label="Open the directions panel"
              className="mt-3 flex h-6 w-6 items-center justify-center rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#2E2E2E] hover:text-white"
              onClick={() => st.setPrefs((prefs) => ({ ...prefs, collapsed: false }))}
              type="button"
            >
              <PIcon d={P.sidebar} size={16} />
            </button>
          </Tip>
        </div>

        {!st.prefs.collapsed && (
          <div
            aria-hidden
            className="group/resize absolute inset-y-0 right-0 z-20 flex w-3 cursor-col-resize touch-none justify-end"
            onPointerDown={st.onHandlePointerDown}
          >
            <span
              className={`h-full transition-all duration-150 ${
                st.resizing
                  ? "w-0.5 bg-[#9CA3AF]"
                  : "w-px bg-[#232328] group-hover/resize:w-0.5 group-hover/resize:bg-[#9CA3AF]"
              }`}
            />
          </div>
        )}
      </aside>

      <span aria-live="polite" className="sr-only" role="status">
        {st.copied === null ? "" : st.copied.kind === "link" ? "Link copied" : "Reference copied"}
      </span>

      <div
        className={`relative min-w-0 flex-1 ${splitting ? "flex" : "overflow-auto"}`}
        ref={attachStage}
      >
        {mounted.map((title) => (
          <Pane
            annotate={
              !viewing && annotating && title === st.active ? (
                <AnnotateLayer
                  notes={activeNotes}
                  onExit={stopAnnotating}
                  onForget={forgetNote}
                  onKeep={(anchor, words) => keepNote(title, anchor, words)}
                  onRevise={reviseNote}
                  paneScale={paneScale}
                  scaling={scaling}
                  sent={notesSent}
                  title={title}
                />
              ) : null
            }
            boxHeight={boxHeight}
            boxWidth={boxWidth}
            branch={st.branchState(title)}
            branchName={st.previewFor(title)?.branch ?? title}
            busy={busy}
            designWidth={designWidth}
            errored={errored[title] === true}
            frameHeight={frameHeight}
            framed={framed}
            fromApp={appPanes.has(title)}
            identity={paneIdentityFor(title)}
            key={title}
            loaded={paneLoaded(title)}
            name={st.displayName(title)}
            onError={() => setErrored((current) => ({ ...current, [title]: true }))}
            onReady={(identity, frame) => markPreviewReady(title, identity, frame)}
            onReload={() => reloadPane(title)}
            onStartBranch={() => st.startBranch(title)}
            order={stagePlace.get(title) ?? -1}
            paneScale={paneScale}
            scaling={scaling}
            second={title === compare}
            serverUp={health.reachable}
            shown={stagePlace.has(title)}
            splitting={splitting}
            src={st.urlFor(title)}
            title={title}
            viewport={st.prefs.viewport}
          />
        ))}

        <div
          className={`absolute z-50 flex gap-2 ${
            widgetDrag
              ? "flex-col items-start"
              : {
                  "bottom-right": "bottom-4 right-4 flex-col items-end",
                  "bottom-left": "bottom-4 left-4 flex-col items-start",
                  "top-right": "right-4 top-4 flex-col-reverse items-end",
                  "top-left": "left-4 top-4 flex-col-reverse items-start",
                }[st.prefs.corner]
          }`}
          style={widgetAnchor}
        >
          <ToolsPopover
            applyOverlayPref={applyOverlayPref}
            copied={st.copied?.kind === "reference" && st.copied.title === st.active}
            fontKey={activeFont.key}
            href={st.urlFor(st.active)}
            notify={st.notify}
            onCopyReference={() => st.copyReference(st.active)}
            onShortcuts={() => {
              setWidgetOpen(false);
              setHelpOpen(true);
            }}
            open={widgetOpen}
            parked={widgetDrag !== null}
            popoverRef={popoverRef}
            prefs={st.prefs}
            setPrefs={st.setPrefs}
            splitting={splitting}
            viewing={viewing}
            viewports={st.viewports}
          />

          {/* Switched off, the button leaves the stage but comes back for as
              long as the popover is open, since the popover is anchored to it
              and the switch that undoes the choice lives inside. */}
          {(st.prefs.showWidget || widgetOpen) && (
            <Tip label="Leglas tools">
              <button
                aria-expanded={widgetOpen}
                aria-haspopup="dialog"
                aria-label="Leglas tools"
                className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[#1C1C20] shadow-lg transition-[border-color,transform] duration-150 hover:scale-[1.04] hover:border-white/20 active:scale-[0.95] motion-reduce:transform-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100"
                onClick={() => {
                  if (widgetClickSuppressed.current) {
                    widgetClickSuppressed.current = false;

                    return;
                  }

                  setWidgetOpen((value) => !value);
                }}
                onPointerDown={onWidgetPointerDown}
                ref={widgetButtonRef}
                type="button"
              >
                <Mark size={30} />
                {!paneLoaded(st.active) && (
                  <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none" />
                )}
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* Above the rail's own footer when there is a rail, and just clear of
          the collapsed strip when there is not. */}
      <Toasts
        bottom={st.prefs.collapsed ? 12 : railFooterH + 8}
        left={st.prefs.collapsed ? 60 : 12}
        onDismiss={st.dismissToast}
        toasts={st.toasts}
        width={(st.prefs.collapsed ? 320 : st.prefs.width) - 24}
      />

      {scanningPreview !== null && (
        <iframe
          aria-hidden
          className="pointer-events-none fixed border-0"
          key={scanKey ?? undefined}
          onLoad={(event) => onScanLoad(scanningPreview, event.currentTarget)}
          ref={activeScanFrame}
          src={scanningPreview.url}
          style={{
            height: DUPLICATE_VIEWPORT.height,
            left: -2400,
            top: 0,
            width: DUPLICATE_VIEWPORT.width,
          }}
          tabIndex={-1}
          title="Off-stage duplicate scan"
        />
      )}

      {helpOpen ? <HelpOverlay mac={IS_MAC} onClose={closeHelp} viewer={viewing} /> : null}
      {mcpConnectOpen ? (
        <McpConnectDialog
          connected={requestSnapshot.agent.attached}
          fallbackFocusRef={chip.kind === "none" ? mcpConnectTriggerRef : agentTriggerRef}
          onClose={() => setMcpConnectOpen(false)}
        />
      ) : null}
      {deletePrompt !== null ? (
        <DeleteRemovedDialog
          busy={deletingRemoved}
          count={deletePrompt.titles.length}
          error={deletePrompt.error}
          fallbackFocusRef={searchRef}
          name={
            deletePrompt.titles.length === 1 ? st.displayName(deletePrompt.titles[0] ?? "") : null
          }
          onCancel={closeDeletePrompt}
          onConfirm={() => void confirmDeleteRemoved()}
        />
      ) : null}
    </main>
  );
}
