import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

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
import { frameRefusal, type FrameRefusal } from "./preview/framing.js";
import { previewFrameForSource, previewMessageSignal } from "./preview/preview-message.js";
import {
  INITIAL_HEALTH,
  needsDevServer,
  nextHealthState,
  type HealthState,
} from "./preview/health.js";
import { nextCompare, paneGeometry, paneTitles, setLayout } from "./preview/compare.js";
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
import { BriefToolbar } from "./generation/BriefToolbar.js";
import { GenerationCard } from "./generation/GenerationCard.js";
import { GenerationCover } from "./generation/GenerationCover.js";
import {
  replaceDirection,
  retryDirection,
  startGeneration,
  stopGeneration,
} from "./generation/generation-api.js";
import {
  agentName,
  isRunning,
  endingOf,
  isSlotOf,
  lastEnded,
  surfacesOf,
  runStartedAt,
  slotsByTitle,
  surfaceOf,
  type GenerationJob,
  type SlotView,
} from "./generation/generation.js";
import { useGeneration } from "./generation/useGeneration.js";
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
import { RailRow, type RowSlot } from "./rail/Row.js";
import { Search } from "./rail/Search.js";
import { ViewerBanner } from "./share/ViewerBanner.js";
import { isString } from "./json.js";
import { readJson } from "./net/api.js";

/** How long a preview may take before it is treated as failed. */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * How often composer focus may ask for a warm agent. The server keeps one warm
 * for minutes after an ask.
 */
const WARM_THROTTLE_MS = 30_000;

/** One render size makes duplicate verdicts independent of the visible stage. */
const DUPLICATE_VIEWPORT = { height: 800, width: 1280 } as const;

/**
 * The rail's foot before it's measured. Its real height moves with the status
 * card, so toasts read it from a ResizeObserver; this covers the first frame.
 */
const RAIL_FOOTER_FALLBACK_H = 96;

/** Room kept around each design in a set shown whole, so neighbours read as separate artboards. */
const GRID_INSET = 32;

/** How long a finished set's card stays above the composer. */
const CARD_KEEP_MS = 10 * 60_000;

const IDLE_AGENT: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
  startedAt: null,
  stopping: false,
  waiting: null,
  quietSince: null,
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

/** The Leglas chrome: the rail, its rows and composer, the stage and the floating tools widget. */
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
  // Stable, so the window key listener attaches once.
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
    onToggleSplit,
    onToggleHelp,
    onToggleTools,
    // A viewer has nothing to annotate with, so the key does nothing rather
    // than open a mode whose writes would be refused.
    onToggleNote: viewer === undefined ? onToggleNote : undefined,
    // While the keymap is showing it's the subject, not a way to drive what's
    // behind it. ? still closes it.
    suspended: helpOpen || deletePrompt !== null || mcpConnectOpen,
    viewer: viewer === undefined ? undefined : { layout: viewer.layout },
  });

  /**
   * Someone else's rail, via a share link. Everything that looks stays;
   * everything that changes what runs, or what the sharer sees, goes.
   */
  const viewing = st.viewing;
  /** The lineage gutter's width, shared by every row so the titles align. */
  const gutter = gutterWidth(st.lanes);
  const insets = st.insets;
  /** The light's own colour, for a working mark's breath and for blooms. */
  const tint = PALETTE.current[0];
  /**
   * Titles the rail has shown. A row not among them just arrived (an agent's
   * new direction) and is marked; a row returning from a fold isn't an arrival.
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
   * The direction whose line back to its root is lit: the one under the pointer
   * in the rail or crumbs, else the one on stage, so the graph always says
   * where what you're looking at came from.
   */
  const [traced, setTracedNow] = useState<string | null>(null);
  /**
   * A hover re-aims the light only once the pointer rests; re-aiming at every
   * row a sweeping hand crosses turns the light into a flicker. Leaving is
   * immediate.
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
   * The light's line and the segments under it, one answer used twice. A hover
   * takes the light only when the row has a line of its own; re-aiming at rows
   * with no lineage while sweeping would make the rail flicker.
   */
  const treeOf = (title: string) =>
    title === "" ? { nodes: [], edges: [] } : tracedTree(st.railParents, st.railChildren, title);

  const hovered = traced !== null ? treeOf(traced) : { nodes: [], edges: [] };
  const litTree = hovered.edges.length > 0 ? hovered : treeOf(st.active);
  const litSegments = tracedSegments(st.rows, st.rowMeta, litTree);
  /**
   * Which segments each row has drawn, so only what's new draws in: the whole
   * rail at first, then the line an agent's next direction adds, and a family's
   * lines again on unfold (only rows on screen are remembered). Rows are
   * remembered a beat after render, so a re-render mid-animation keeps the
   * stroke going.
   */
  const drawnSegments = useRef(new Map<string, Set<string>>());
  /** Whether this render handed any segment the drawing class. */
  const drawing = useRef(false);
  drawing.current = false;
  // A render after drawing settles, to take the classes off. Only requested
  // when something drew, which keeps it from looping.
  const [, settle] = useReducer((count: number) => count + 1, 0);

  const freshFor = (title: string): Set<Segment> | undefined => {
    const graph = st.rowMeta.get(title)?.graph;

    if (!graph) return undefined;
    const drawn = drawnSegments.current.get(title);
    const fresh = new Set(segmentsOf(graph).filter((segment) => !drawn?.has(segment)));

    if (fresh.size > 0) drawing.current = true;

    return fresh;
  };

  // Keyed on what the gutter draws, not renders: the shell re-renders far more
  // often than every 700ms, and a timer reset each time would never fire.
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
   * Folding on a graph rail is animated by the browser: staying rows slide and
   * leaving rows fade, instead of the list snapping.
   */
  const foldFamily = (title: string) => {
    if (!stillMotion && "startViewTransition" in document) {
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

  // The widget is the only way into the tools, so it must never end up under a
  // busy drag's pointer-blocking overlay, or off stage after a resize.
  const [widgetDrag, setWidgetDrag] = useState<{ x: number; y: number } | null>(null);
  const widgetDragging = widgetDrag !== null;
  // Pointer capture keeps the click alive through a drag, so the press that
  // parked the widget would also open the tools. The rail suppresses its
  // post-drag click the same way.
  const widgetClickSuppressed = useRef(false);
  // The composer, where the direction is being looked at; the user's own agent
  // still does the work, since it knows the codebase. It sits under the rail,
  // where the highlighted row above it is the direction it means, not in the
  // tools popover among preferences.
  const [intent, setIntent] = useState("");
  /**
   * Whether the next change forks or rewrites. Variant every session, not
   * remembered: only one of the two can be undone, so a fresh window starts
   * safe. The chip by send shows which is armed.
   */
  const [mode, setMode] = useState<"variant" | "replace">("variant");
  const [sending, setSending] = useState(false);

  // The composer's second use: taking a brief to build a set. Its own draft, so
  // switching never loses either text.
  const buildEnabled = st.prefs.buildDirections && !viewing;
  const [briefOpen, setBriefOpen] = useState(false);
  const briefing = briefOpen && buildEnabled;
  const [brief, setBrief] = useState("");
  const [briefCount, setBriefCount] = useState(3);
  /** The brief builds variations of the active direction rather than new directions. */
  const [briefLike, setBriefLike] = useState(false);
  const [starting, setStarting] = useState(false);
  /**
   * Buttons waiting on the server, by `job:slot` (or `job:set`), with the mark
   * each was pressed at. A button stays busy until a read shows the mark moved
   * on, not just until the request answers, so a second press can't land
   * between.
   */
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** Presses whose request has not answered yet; busy whatever the set does meanwhile. */
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  /** The ending of a set the person dismissed; a later ending of the same set shows again. */
  const [dismissedEnding, setDismissedEnding] = useState<string | null>(null);
  /** A set shown whole on the stage, and the direction that was there when it opened. */
  const [grid, setGrid] = useState<{ job: string; from: string } | null>(null);
  const { jobs, noteJob } = useGeneration(buildEnabled);
  const slotViews = useMemo(() => slotsByTitle(jobs), [jobs]);
  // A retry or new idea can restart an older set; the running one leads, and
  // with nothing running the card shows whichever ended last.
  const runningJob = jobs.find(isRunning) ?? null;
  const cardJob = runningJob ?? lastEnded(jobs);
  const activeSurface = st.active === null ? null : surfaceOf(st.urlFor(st.active));
  // Every surface the directions sit on. The brief targets the one on stage
  // unless another is picked in its header.
  const surfaces = useMemo(() => surfacesOf(previews.map((preview) => preview.url)), [previews]);
  const [pickedSurface, setPickedSurface] = useState<string | null>(null);

  const briefSurface =
    pickedSurface !== null && surfaces.includes(pickedSurface)
      ? pickedSurface
      : (activeSurface ?? (surfaces.length === 1 ? (surfaces[0] ?? null) : null));

  // The field grows from one row, line by line, to a cap. Measured from
  // scrollHeight, since wrapping depends on the rail width and chosen typeface.
  useEffect(() => {
    const field = requestRef.current;

    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 96)}px`;
  }, [intent, brief, briefing, st.prefs.width]);

  /** What a slot's button waits to see change: its state and when it last started. */
  const slotMark = (view: SlotView) => `${view.slot.state}@${view.slot.startedAt ?? ""}`;

  /** The same for the whole set: its state and when its current run began. */
  const setMark = (job: GenerationJob) => `${job.state}@${runStartedAt(job)}`;

  // A wait whose mark no longer matches has been answered; it stays in the map
  // until the next press replaces it.
  const actOnGeneration = (key: string, mark: string, work: () => Promise<void>) => {
    if (inFlight.has(key) || pending.get(key) === mark) return;
    setPending((current) => new Map(current).set(key, mark));
    setInFlight((current) => new Set(current).add(key));
    void work()
      .catch((error) => {
        setPending((current) => new Map([...current].filter(([held]) => held !== key)));
        st.notify({
          kind: "generation",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() =>
        setInFlight((current) => new Set([...current].filter((held) => held !== key))),
      );
  };

  /** A button is busy while its request is out, and until a read shows its mark moved on. */
  const generationBusy = (key: string, mark: string) =>
    inFlight.has(key) || pending.get(key) === mark;

  /** A title's slot, when the direction under that title really is the slot's. */
  const slotFor = (title: string): SlotView | undefined => {
    const view = slotViews.get(title);

    return view !== undefined && isSlotOf(st.urlFor(title), view) ? view : undefined;
  };

  // A set shown whole, one cell per ready direction. It lasts while the
  // direction on stage when it opened stays there: picking any row ends it.
  // Cleared during render, since every stage change passes through here.
  if (grid !== null && grid.from !== st.active) setGrid(null);

  /** A set's finished directions that are still on the rail: what showing it whole shows. */
  const shownWhole = (job: GenerationJob | undefined): string[] =>
    job === undefined
      ? []
      : job.slots.flatMap((slot) =>
          slot.state === "ready" && slotFor(slot.title) !== undefined ? [slot.title] : [],
        );

  const gridSet =
    grid !== null && grid.from === st.active ? jobs.find((job) => job.id === grid.job) : undefined;

  const gridTitles = shownWhole(gridSet);
  const cardWhole = shownWhole(cardJob ?? undefined);

  const gridding = gridTitles.length >= 2;

  // Variations need a direction on a surface with a file to start from, so one
  // being built or failed has nothing to offer. With a set shown whole, its
  // origin direction is off stage.
  const activeSlot = st.active === null ? undefined : slotFor(st.active);

  const likeTitle =
    !gridding &&
    st.active !== null &&
    activeSurface !== null &&
    (activeSlot === undefined || activeSlot.slot.state === "ready")
      ? st.active
      : null;

  const briefBase = briefLike ? likeTitle : null;
  const buildSurface = briefBase === null ? briefSurface : activeSurface;

  const slotActions = (view: SlotView) => {
    const key = `${view.job.id}:${view.slot.key}`;
    const mark = slotMark(view);
    const { job, slot } = view;

    return {
      acting: generationBusy(key, mark),
      onReplace: () => actOnGeneration(key, mark, () => replaceDirection(job.id, slot.key)),
      onRetry: () => actOnGeneration(key, mark, () => retryDirection(job.id, slot.key)),
      onStop: () => actOnGeneration(key, mark, () => stopGeneration(job.id, slot.key)),
    };
  };

  const rowSlot = (title: string): RowSlot | null => {
    const view = slotFor(title);

    return view === undefined
      ? null
      : { slot: view.slot, agent: agentName(view.job.agent), ...slotActions(view) };
  };

  // A finished set's card goes after ten minutes, on its own; a running one always shows.
  useEffect(() => {
    if (cardJob === null || isRunning(cardJob) || cardJob.endedAt === null) return;
    const left = cardJob.endedAt + CARD_KEEP_MS - Date.now();

    if (left <= 0) return;
    const timer = window.setTimeout(() => setDismissedEnding(endingOf(cardJob)), left);

    return () => window.clearTimeout(timer);
  }, [cardJob]);

  // A set's rows arrive at the end of the rail, often below the fold. The first
  // is scrolled into view once it exists, so the build is seen starting; the
  // config read adding the rows can land after the job's.
  const revealedJob = useRef<string | null>(null);
  // Only a set seen planning is revealed; a retry on an older set mustn't
  // scroll the pressed row out from under the pointer.
  const plannedHere = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const job of jobs) if (job.state === "planning") plannedHere.current.add(job.id);
  }, [jobs]);

  useEffect(() => {
    const first = runningJob?.slots[0];

    if (runningJob === null || first === undefined) return;

    if (revealedJob.current === runningJob.id || !plannedHere.current.has(runningJob.id)) return;
    const row = document.querySelector(`li[data-title="${CSS.escape(first.title)}"]`);

    if (row === null) return;
    revealedJob.current = runningJob.id;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  }, [runningJob, st.rows]);

  // "Try a new idea" brings a replacement under a new title and the old one
  // leaves. The stage follows the slot to its new title instead of falling back
  // to the app's page; picking another row lets go.
  const followedSlot = useRef<{ job: string; key: string; title: string } | null>(null);

  useEffect(() => {
    // The same test as slotFor, inline so the effect depends only on what it reads.
    const found = st.active === null ? undefined : slotViews.get(st.active);

    const view =
      found !== undefined && st.active !== null && isSlotOf(st.urlFor(st.active), found)
        ? found
        : undefined;

    if (view !== undefined) {
      followedSlot.current = { job: view.job.id, key: view.slot.key, title: view.slot.title };

      return;
    }

    const last = followedSlot.current;

    if (last === null || st.active !== last.title) {
      followedSlot.current = null;

      return;
    }

    const renamed = [...slotViews.values()].find(
      (candidate) => candidate.job.id === last.job && candidate.slot.key === last.key,
    );

    if (renamed === undefined || renamed.slot.title === last.title) return;

    if (st.previewFor(renamed.slot.title) === undefined) return;
    followedSlot.current = { job: last.job, key: renamed.slot.key, title: renamed.slot.title };
    st.setActive(renamed.slot.title);
  }, [slotViews, st, previews]);

  const submitBrief = () => {
    const value = brief.trim();

    if ((value === "" && briefBase === null) || buildSurface === null || starting) return;
    setStarting(true);
    void startGeneration({
      surface: buildSurface,
      brief: value,
      count: briefCount,
      basedOn: briefBase,
    })
      .then((job) => {
        noteJob(job);
        setBrief("");
        setBriefOpen(false);
        setDismissedEnding(null);
      })
      .catch((error) =>
        st.notify({
          kind: "generation",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
          ttl: TOAST_TTL.action,
        }),
      )
      .finally(() => setStarting(false));
  };

  /**
   * Reference images for the next change, uploaded as they arrive so sending
   * only names ids and the strip shows which landed. File objects wait in a
   * ref, so a failed draft can retry with its bytes.
   */
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const referenceFiles = useRef(new Map<string, File>());
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  // A drag is counted in and out, not flagged: entering a child fires leave on
  // the parent, and a boolean flickers as the pointer crosses the field.
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

  // Toasts stack on the rail's foot, whose height moves with the status card,
  // so they follow a measurement.
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
  // active row has its own surface, so this is hover only.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [glow, setGlow] = useState({ height: 0, left: 0, on: false, top: 0 });

  // The glow covers the card, which starts past the lineage gutter, not the
  // whole row.
  const glowFor = (row: HTMLElement) => ({
    height: row.offsetHeight,
    left: row.querySelector<HTMLElement>('[role="button"]')?.offsetLeft ?? 0,
    on: true,
    top: row.offsetTop,
  });

  // The panel is measured from the row the pointer entered, and rows move as a
  // search narrows or a family folds; any change to the rows puts it away until
  // the pointer moves again.
  useEffect(() => {
    setGlow((current) => (current.on ? { ...current, on: false } : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.rows.join("|")]);

  // Window listeners, not pointer capture, so a drag survives leaving the rail;
  // 4px separates it from a click.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragMeta = useRef<DragMeta | null>(null);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  /**
   * Cmd K and R name a rail field; this focuses it. An effect, not the key
   * handler, because both keys open a collapsed rail first, and until that
   * commits the field is inert and refuses focus.
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

          // The first real movement decides the gesture: down reorders, across
          // selects text. A row is both a handle and words, and making people
          // find the sliver that's only one of them made reordering feel
          // broken.
          if (Math.abs(dx) > Math.abs(dy)) return null;
          // Clear what the browser selected on the way to the threshold; from
          // here the rail is `select-none`.
          window.getSelection()?.removeAllRanges();
          // The rows around this one fold for the drag, so what can be ordered
          // is what's on screen and a family moves as one row. Positions are
          // re-measured once the fold lays out.
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
        // Where the row would sit in each slot its siblings offer. Rows differ
        // in height, so the nearest slot wins rather than midpoint crossing,
        // which keeps travel and target in step with both ends reachable. The
        // span comes from the re-measure after the fold; the whole-rail
        // fallback only covers the frames before it and never widens a family's
        // slots.
        const [first, last] = current.span ?? [0, meta.rows.length - 1];

        const slotTop = (index: number): number => {
          const slot = meta.rows[index];

          if (!slot) return row.top;

          return index <= current.from ? slot.top : slot.top + slot.height - row.height;
        };

        const low = slotTop(first) - row.top;
        const high = slotTop(last) - row.top;
        // The pointer gets a row of give; the row shows a third of it, peeking
        // past the edge without covering its neighbour.
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
      // Let go past the edge and the row goes back, with the reason said once
      // in words; the chip was the short form.
      const refused = current.blocked && current.reason !== null;
      const to = refused ? current.from : current.to;
      // Ease the dragged row into its slot (the others already made room), then
      // commit, so the swap doesn't snap.
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

  // A lineage rail folds the rows around the dragged one when the drag starts,
  // so press-time positions are stale. Re-measure after the fold and shift the
  // origin by how far the row moved, so it stays under the pointer.
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
   * Why a drop went back, in words; the row's chip said it during the push,
   * this adds the way forward.
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
  // back to the button on close. Clicking into a preview blurs the window,
  // which closes it too.
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
      const target = event.target instanceof Node ? event.target : null;

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

  // Kept on one line: a label wrapping in a fixed-height row overflows and
  // looks broken, and how close each label is to wrapping depends on the chosen
  // typeface.
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
   * The light down the traced line, measured from the marks the rail drew
   * rather than layout constants, so the two can't disagree and a reflow is
   * measured again. Not while dragging: the rows move away from where they were
   * measured, and a chasing light is noise during a gesture.
   */
  type TrailDrawing = { d: string; height: number; marks: TrailMark[] };

  /**
   * The light on stage and, briefly, the one it replaced: a lineage change
   * crossfades on the same clock, so the current reroutes instead of
   * restarting.
   */
  const [trail, setTrail] = useState<TrailDrawing | null>(null);
  /** Every light still fading out, each dropped once its fade is done. */
  const [leaving, setLeaving] = useState<readonly TrailDrawing[]>([]);
  const traceEdges = litTree.edges;
  const trailKey = `${traceEdges.map((edge) => edge.join(">")).join(",")}|${dragging}|${st.prefs.width}|${gutter}`;

  const replaceTrail = (next: TrailDrawing | null) =>
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
      // Found by reading each row's title, not by selector: CSS.escape makes
      // identifiers, not attribute values, so a name starting with a digit
      // would never match and the light would silently not show.
      const rows = [...list.querySelectorAll<HTMLElement>("li[data-title]")];

      for (const title of litTree.nodes) {
        const row = rows.find((entry) => entry.dataset.title === title);
        const mark = row?.querySelector("[data-mark]");

        if (!row || !mark) return replaceTrail(null);
        const dot = mark.getBoundingClientRect();
        // The room the light leaves around a mark: a dot's radius plus some
        // air, more for the ring on stage, none for a hair tick.
        const radius = Number(mark.getAttribute("r") ?? 0);
        const ring = title === st.active ? 3.75 : 0;
        at.set(title, {
          clear: ring > 0 || radius > 1.5 ? radius + 2 + ring : 0,
          x: dot.left + dot.width / 2 - box.left,
          y: dot.top + dot.height / 2 - row.getBoundingClientRect().top + row.offsetTop,
        });
      }

      // Each edge is its own subpath, so a forked tree is one path the light
      // runs down and splits along.
      const d = traceEdges
        .flatMap(([parent, child]) => {
          const from = at.get(parent);
          const to = at.get(child);

          return from && to ? [trailPath([from, to])] : [];
        })
        .join(" ");

      replaceTrail({ d, height: list.scrollHeight, marks: [...at.values()] });
    };

    measure();
    // Row heights change with the rail's width, a rename or a note wrapping,
    // none of which this effect would otherwise hear.
    const observer = new ResizeObserver(measure);
    observer.observe(list);

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, trailKey]);
  // Dragging the widget counts as busy too, or a preview under it lights its
  // own hover states.
  const busy = st.resizing || dragging || widgetDragging;

  const [errored, setErrored] = useState<Record<string, boolean>>({});
  /** Absolute-URL pages that refused to be framed, by title. */
  const [refused, setRefused] = useState<Record<string, FrameRefusal>>({});
  /**
   * Pages the reader saw frame after all, by address. Leglas asks without
   * cookies, so this overrules it, for the session only.
   */
  const framesAnyway = useRef(new Set<string>());
  const [reloadTick, setReloadTick] = useState<Record<string, number>>({});

  // Flipping shows a difference over time; a split shows it at once, for the
  // last two contenders. A comparison share opens as the comparison: the
  // sharer's pair side by side.
  const [split, setSplit] = useState(viewer?.scope === "compare");
  const [comparePin, setComparePin] = useState<string | null>(viewer?.layout.compare ?? null);

  // A pushed share moves the stage with it, settled during render so the old
  // pair never shows.
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
    // Cleanup runs just before the next change, so this holds the previously
    // viewed direction.
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

  const visible = gridding ? gridTitles : paneTitles({ active: st.active, compare, split });
  const gridLayout = gridding ? setLayout(visible.length) : { columns: visible.length, rows: 1 };
  // Escape leaves a set shown whole, unless something nearer the key took it.
  useEffect(() => {
    if (!gridding) return;

    const leave = (event: KeyboardEvent) => {
      // A popover, modal or focused field takes Escape first, whichever
      // listener runs first: a native dialog only cancels after this runs.
      const nearer =
        document.activeElement instanceof Element &&
        document.activeElement.closest(
          'dialog[open], [role="dialog"], [role="alertdialog"], input, textarea',
        ) !== null;

      if (event.key === "Escape" && !event.defaultPrevented && !nearer) setGrid(null);
    };

    window.addEventListener("keydown", leave);

    return () => window.removeEventListener("keydown", leave);
  }, [gridding]);

  /** Where each direction on the stage sits, left to right. */
  const stagePlace = new Map(visible.map((title, index) => [title, index]));
  const splitting = visible.length > 1;
  // Only the visible stage stays alive. An exported app can carry a full client
  // runtime, so keeping every opened direction multiplies memory and network
  // for nothing visible.
  const mounted = visible;
  const previousMounted = useRef(new Map<string, string>());

  const paneIdentityFor = (title: string) =>
    previewIdentity(title, st.urlFor(title), reloadTick[title] ?? 0);

  const paneLoaded = (title: string) => {
    const identity = paneIdentityFor(title);

    return previousMounted.current.get(title) === identity && st.isLoaded(title, identity);
  };

  /**
   * A branch pane on stage asks for its branch to start. Opening it is the
   * trigger, so nothing checks out until someone looks. Asking again mid-start
   * is free, since the server joins the start in flight.
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

  // Reset before paint, or a reused title draws one frame with its old loaded
  // state before the skeleton.
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

    // A new document is asked again when it loads; until then it has no answer.
    if (changed.some(([title]) => refused[title] !== undefined)) {
      const stale = new Set(changed.map(([title]) => title));

      setRefused((current) =>
        Object.fromEntries(Object.entries(current).filter(([title]) => !stale.has(title))),
      );
    }

    previousMounted.current = new Map(mountedIdentities);
  }, [mountedIdentityKey]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageWatch = useRef<ResizeObserver | null>(null);
  const [stage, setStage] = useState({ height: 0, width: 0 });

  /**
   * A callback ref, not an effect: an effect observing `stageRef.current` once
   * runs before a gated stage exists, and an observer that never attached
   * reports zero forever, which reads as "nothing to scale".
   */
  const attachStage = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    stageWatch.current?.disconnect();

    if (node === null) return;
    // Measured once as well as observed: a ResizeObserver waits for a
    // compositor frame, so the first render would think the stage is nothing
    // and draw the split unscaled.
    const first = node.getBoundingClientRect();
    setStage({ height: first.height, width: first.width });

    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;

      if (box) setStage({ height: box.height, width: box.width });
    });

    observer.observe(node);
    stageWatch.current = observer;
  }, []);

  // The same for every pane, so worked out once; the reasoning is on the
  // function.
  const {
    boxHeight,
    boxWidth,
    designWidth,
    frameHeight,
    scale: paneScale,
    scaling,
  } = paneGeometry({
    gutter: FRAME_GUTTER,
    panes: gridLayout.columns,
    rows: gridLayout.rows,
    inset: gridding ? GRID_INSET : 0,
    // A set shown whole is always scaled; reflowed into small cells, every
    // design would be judged at a width nobody ships.
    scaleSplit: gridding || st.prefs.scaleSplit,
    stageHeight: stage.height,
    stageWidth: stage.width,
    viewport: st.prefs.viewport,
  });

  /**
   * The width the active design is drawn at, for the capture sent with a
   * request: a preset's own width; else the stage's width alone, or half of it
   * in an unscaled split (a scaled split keeps the design width). Null until
   * measured, when the server picks a default.
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
    // Pointer capture routes every move here even over a preview; otherwise the
    // iframe takes the events and the widget freezes over a design. The rail's
    // resize handle does the same.
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    widgetClickSuppressed.current = false;
    // A tap is never still, so the widget follows only after enough travel, and
    // a click through to the button survives.
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

      // A drag settles into a corner, never over the middle of a design.
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
   * Watches for dev server restarts, which are routine. Without this an outage
   * is found one pane at a time after 15s, nothing retries on return, and panes
   * loaded before it died keep showing a stale render as current.
   */
  const [health, setHealth] = useState<HealthState>(INITIAL_HEALTH);
  // Which panes render through that server, and whether any do. With only file
  // and branch previews on screen, "localhost:3000 is down" isn't news and the
  // outage UI stays away.
  //
  // A fresh Set every render, left out of the reading effects' deps on purpose
  // (it would fire them every render); each effect runs with its own render's
  // closure, so it's current when read.
  const appPanes = new Set(previews.filter(needsDevServer).map((preview) => preview.title));
  const needsApp = appPanes.size > 0;

  const [requestSnapshot, setRequestSnapshot] = useState<{
    requests: RequestStatus[];
    agent: AgentStatus;
  }>({ requests: [], agent: IDLE_AGENT });

  /**
   * The notes on every direction, and whether the preview is taking new ones. A
   * mode, not a live click target, because the preview is a running app and
   * reaching the state worth annotating means clicking through it first. A mode
   * that must be asked for also can't be entered by accident.
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
  // Bumped after a submit so the hint updates at once; the effect restarting is
  // the immediate poll.
  const [requestsTick, bumpRequests] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    // A guard per effect run, like the health poll: a shared flag would be
    // reset by a remount while the old run's fetch is in flight. None of this
    // is served to a viewer.
    if (viewing) return;
    let cancelled = false;

    const poll = async (signal: AbortSignal) => {
      const signalled: NoteFetcher = (input, init) => fetch(input, { ...init, signal });
      await fetch("/leglas/api/requests", { signal })
        .then((response) => readJson<{ requests: RequestStatus[]; agent?: AgentStatus }>(response))
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
        // Caught per read: one of the pair failing is no reason to skip the
        // other.
        .catch(() => {});
      // Read on the queue's beat because the two move together: a change in
      // place forgets the notes it answered, and watching only the queue would
      // leave pins on a fixed design. After it rather than beside it, so the
      // beat costs one socket; both are local JSON.
      await readNotes(signalled)
        .then((fresh) => {
          if (cancelled) return;
          setNotes((current) =>
            JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh,
          );
        })
        .catch(() => {});
    };

    // One nudge drives both reads, which keeps them a pair; annotations have no
    // kind of their own, so this beat can't be split later.
    const stop = startPoll(poll, {
      everyMs: FALLBACK_MS,
      subscribe: (run) => liveConnection().on("requests", run),
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [requestsTick, viewing]);
  // Two readings of one snapshot: the chip says who Enter sends to, the card
  // what's happening now. They used to share one footer slot, so a running
  // request hid the chooser.
  const chip = composerAgent(agentState.choice, agentState.agents, agentState.customRun);

  // Who builds a set: the chosen agent, when it is one Leglas can build with.
  const briefAgent =
    chip.kind === "chosen" && (chip.id === "claude" || chip.id === "codex") ? chip.id : null;

  const briefAgentName = briefAgent === null ? "Claude or Codex" : agentName(briefAgent);

  // Why the brief can't build now, shown in the button's place; Enter obeys it
  // too.
  const briefReason =
    briefAgent === null
      ? "Building directions runs on Claude or Codex."
      : runningJob !== null
        ? "A set is being built. Wait for it, or stop it."
        : buildSurface === null
          ? "Pick a direction on the surface first."
          : null;

  // Composer focus is the first honest sign a request is coming, and typing
  // hides the agent's startup. Nothing warms earlier: a saved choice isn't a
  // request.
  const lastWarmAsk = useRef(0);

  const warmChosenAgent = () => {
    if (chip.kind !== "chosen") return;
    const now = Date.now();

    if (now - lastWarmAsk.current < WARM_THROTTLE_MS) return;
    lastWarmAsk.current = now;
    void warmAgent().catch(() => {
      // Only latency is lost; the request warms the agent anyway.
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
   * Where the direction being changed came from, said unasked. The rail shows
   * this on hover for browsing, but for the direction in the composer's sights
   * its origin and last ask decide what's typed next.
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
  // Same dismissal as the tools popover: Escape, clicking away or window blur
  // closes the menu.
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
      const target = event.target instanceof Node ? event.target : null;

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
        .then((response) => readJson<{ reachable: boolean }>(response))
        .then(({ reachable }) => {
          if (!cancelled) setHealth((current) => nextHealthState(current, reachable));
        })
        .catch(() => {
          // Leglas itself is unreachable, which isn't the dev server's fault,
          // and the page will fail visibly anyway.
        });

    // The server probes the dev server once for every interface and says so
    // only when the answer changes. A restart is still noticed on the same
    // beat.
    const stop = startPoll(poll, {
      everyMs: FALLBACK_MS,
      subscribe: (run) => liveConnection().on("health", run),
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Once it answers again, reload what broke instead of making the user click
  // through every pane. Only panes that went down with it: a file preview kept
  // rendering, and flashing its skeleton would claim it broke.
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

      // Every app-backed pane, not just those that ever loaded: a pane whose
      // first navigation failed never reported, and skipping it left it showing
      // a dead page with nothing saying so.
      for (const title of appPanes) {
        next[title] = (next[title] ?? 0) + 1;
      }

      return next;
    });
    setHealth((current) => ({ ...current, wasDown: false }));
  }, [health.reachable, health.wasDown]);

  // A declared URL can lie: a typo the app ignores serves the default page and
  // two directions draw the same thing. Read from what each pane rendered, the
  // claim made on screen and the only way for client-rendered apps.
  const [scans, setScans] = useState<Record<string, PreviewScan>>({});

  // A background read costs a full app boot, so not in a hidden tab. Hiding
  // mid-read drops the frame; the direction is read again on return.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);

    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // A pane replaced in place loses its verdict before the new document paints;
  // scanSignatures rejects URL changes, but a retry of the same URL needs this
  // reset. Coming on stage keeps the verdict.
  //
  // Every direction is tracked, not just mounted ones: a dev server recovery
  // reloads every app-backed direction, mostly off stage, and without earlier
  // identities a changed page kept its old duplicate verdict.
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
   * Hides the framework's dev badge inside a preview: tooling over the corner
   * being judged, doubled in a split. Error overlays stay; Next renders badge
   * and error modals into one `nextjs-portal`, so this reaches into its open
   * shadow root for the badge alone. Injected into the frame, not the proxied
   * response, so the bytes Leglas forwards are the dev server's own.
   */
  const applyOverlayPref = (frame: HTMLIFrameElement, hide: boolean) => {
    let doc: Document | null = null;

    try {
      doc = frame.contentDocument;
    } catch {
      return;
    }

    if (!doc?.head) return;
    const owner = doc;

    const ID = "leglas-hide-dev-overlays";

    // Looked up on the document but appended to its head, since a Document
    // holds only one element.
    const put = (find: Document | ShadowRoot, into: Node, css: string) => {
      const existing = find.getElementById(ID);

      if (!hide) {
        existing?.remove();

        return;
      }

      if (existing) return;
      const style = owner.createElement("style");
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
   * Re-applied to every frame after each render. On load alone isn't enough: a
   * fresh iframe fires load for about:blank before navigating, so the style
   * landed in a discarded document and a real Next badge stayed visible.
   * Idempotent, so each render costs a lookup per pane.
   */
  useEffect(() => {
    for (const frame of document.querySelectorAll("iframe")) {
      applyOverlayPref(frame, !st.prefs.showDevOverlays);
    }
  });

  const readRendered = (frame: HTMLIFrameElement): string | null | undefined => {
    // Cross-origin panes are unreadable by design; a branch or deployed URL
    // goes uncompared.
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
      ? paintSample<Element>(doc.body, (element) => {
          const style = view.getComputedStyle(element);

          return {
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            color: style.color,
          };
        })
      : [];

    const visual = view
      ? visualSample<Element>(doc.body, (element, pseudo) => view.getComputedStyle(element, pseudo))
      : [];

    return renderedSignature(doc.body.innerText ?? "", tags, paint, visual);
  };

  /**
   * Fingerprinting hundreds of computed styles waits until the preview has
   * painted and the browser is idle. A short wait for fonts avoids recording a
   * fallback-font layout; a deadline keeps a slow font from stalling the scan.
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

      if (typeof window.requestIdleCallback !== "undefined") {
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

    // A page loaded from its own address fires load even when it refused the
    // frame and the browser drew its broken page. Ask before the skeleton
    // lifts, so the refusal shows instead of a flash of that page.
    const src = st.urlFor(title);

    if (!src.startsWith("/") && !framesAnyway.current.has(src)) {
      void frameRefusal(title).then((refusal) => {
        if (currentPaneIdentities.current.get(title) !== identity) return;

        if (refusal !== null) setRefused((current) => ({ ...current, [title]: refusal }));
        settleReady(title, identity, frame);
      });

      return;
    }

    settleReady(title, identity, frame);
  };

  const settleReady = (title: string, identity: string, frame: HTMLIFrameElement) => {
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
   * The duplicate check without waiting for clicks. Signatures used to come
   * only from opened panes, so "Same as" showed up one click at a time, after
   * the judgment it protects. One hidden off-stage frame walks every
   * same-origin preview in turn at a fixed size, records its signature and
   * unmounts: one extra app instance at a time, independent of the stage size.
   *
   * Parked off-viewport, not display:none, since a hidden document lays out
   * nothing. Proxied previews queue only while the dev server answers; previews
   * Leglas serves itself scan regardless.
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

  // A result recorded before an edit must not reappear when the queue settles,
  // so the directions being edited are cleared once per live-work transition
  // and hidden in the render that first reports the work. Only those: a run
  // naming no direction, which can show for a beat between requests, used to
  // clear every verdict.
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

  // A hung navigation is a failed check, not an empty valid signature.
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
    // A fresh iframe fires load for about:blank first; the visible watcher
    // rejects it, and the scanner must too.
    if (!previewFrameIsReady(frame)) return;
    // A hidden badge leaves its text, so every read applies the same overlay
    // preference before measuring.
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

      // A known-down dev server needs no waiting, but a file preview is
      // Leglas's own and gets the normal window.
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

      // Buttons keep their clicks and selectable elements their selection. The
      // note used to be selectable, which took the bottom half of every row out
      // of the drag gesture; now the press's direction decides the gesture, not
      // where it started.
      if (event.target instanceof Element && event.target.closest("button, [data-selectable]"))
        return;
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
      // On a lineage rail a row orders only among its siblings, since its
      // parent is a fact about the design. The limits are set here so the row
      // can say so as soon as it's pushed.
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

  // The other rows make room: down by the dragged row's height as the insertion
  // point passes above them, up when below.
  const shiftFor = (index: number): number => {
    if (!drag?.started) return 0;
    const pitch = drag.height + drag.gap;

    if (index < drag.from && index >= drag.to) return pitch;

    if (index > drag.from && index <= drag.to) return -pitch;

    return 0;
  };

  /** Leaving the mode is all the shell has to know about it. */
  const stopAnnotating = useCallback(() => setAnnotating(false), []);

  // Both answer whether the words landed, since the card stays open until they
  // have; losing typed words to a failed write is what an annotation must never
  // do.
  const keepNote = (title: string, anchor: Anchor, text: string): Promise<boolean> => {
    // Annotations alone make a request, so the first pin is as good a sign as
    // typing that one is coming; otherwise that path started its agent cold.
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
   * The design alone in a new tab. A preview URL is the app's own, so it fills
   * the window without this chrome, the closest thing to seeing it shipped.
   */
  const openAlone = (title: string) => {
    window.open(st.urlFor(title), "_blank", "noopener,noreferrer");
  };

  // One picker, in the composer's toolbar or beside the brief's reason when it asks for another agent.
  const agentPicker = (
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
  );

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
            briefing={briefing}
            compare={splitting && !gridding ? compare : null}
            displayName={st.displayName}
            notify={st.notify}
            onBuild={
              buildEnabled
                ? () => {
                    setBriefOpen(!briefing);

                    if (!briefing) window.requestAnimationFrame(() => requestRef.current?.focus());
                  }
                : null
            }
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
              // Lines past the viewport fade out rather than being cut, so the
              // lineage reads as running through the rail.
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
                  comparing={splitting && !gridding && title === compare}
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
                  // Picking the row a set was opened from shows that direction alone again.
                  onPick={() => setGrid(null)}
                  onPointerDown={onRowPointerDown(title, index)}
                  onToggleCompare={() => {
                    // Comparing two is a different view from the set shown whole.
                    setGrid(null);

                    if (splitting && !gridding && title === compare) {
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
                  slot={buildEnabled ? rowSlot(title) : null}
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

          {/* The rail's foot as one measured block, since the card above the
              composer moves its height and the toasts stack on it. */}
          <div ref={railFooterRef}>
            {buildEnabled &&
              cardJob !== null &&
              (isRunning(cardJob) ||
                (endingOf(cardJob) !== dismissedEnding &&
                  cardJob.endedAt !== null &&
                  Date.now() - cardJob.endedAt < CARD_KEEP_MS)) && (
                <GenerationCard
                  compare={
                    cardWhole.length >= 2
                      ? {
                          count: cardWhole.length,
                          toggle: () =>
                            setGrid(
                              gridding && gridSet?.id === cardJob.id
                                ? null
                                : { from: st.active, job: cardJob.id },
                            ),
                        }
                      : null
                  }
                  comparing={gridding && gridSet?.id === cardJob.id}
                  job={cardJob}
                  onDismiss={() => setDismissedEnding(endingOf(cardJob))}
                  onStop={() =>
                    actOnGeneration(`${cardJob.id}:set`, setMark(cardJob), () =>
                      stopGeneration(cardJob.id),
                    )
                  }
                  stopping={generationBusy(`${cardJob.id}:set`, setMark(cardJob))}
                />
              )}
            {!viewing && card !== null && (
              <StatusCard
                action={requestAction}
                card={card}
                onCancel={cancelRequest}
                onDismiss={dismissRequest}
                onRetry={retryRequest}
              />
            )}
            {/* Enter queues the request and copies the prompt, so it works
                whether the agent drains the queue or the prompt is pasted by
                hand. Confirmed by a toast. */}
            {!viewing && (
              <form
                className="relative px-3 pb-2.5 pt-2"
                onSubmit={(event) => {
                  event.preventDefault();

                  if (briefing) {
                    if (briefReason === null) submitBrief();

                    return;
                  }

                  const value = intent.trim();
                  const title = st.active;

                  // Notes carry their own words and address, so pins alone are
                  // a request; nothing at all isn't. A set shown whole has no
                  // one direction to change; its names open one.
                  if ((!value && activeNotes.length === 0) || !title || sending || gridding) return;
                  const name = st.displayName(title);
                  // An uploading image lands in a moment; a failed one needs a
                  // decision, or sending would drop an attachment made on
                  // purpose.
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

                  type RequestBody = {
                    title: string;
                    intent: string;
                    mode: typeof mode;
                    width?: number;
                    compare?: string;
                    references?: typeof attached;
                  };

                  const body: RequestBody = { title, intent: value, mode };

                  // The drawn width, so the agent sees the layout being judged.
                  if (drawnWidth !== null) body.width = drawnWidth;

                  // The other pane, if any: "the other one" means it, and the
                  // agent should see it too.
                  if (splitting && compare !== null && compare !== title) body.compare = compare;

                  if (attached.length > 0) body.references = attached;
                  setSending(true);
                  void fetch("/leglas/api/request", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  })
                    .then((response) =>
                      readJson<{
                        ok: boolean;
                        prompt?: string;
                        duplicate?: boolean;
                        error?: string;
                      }>(response),
                    )
                    .then((result) => {
                      // The same words at the same direction are already
                      // waiting. The field keeps them so they can be reworded;
                      // anything else still queues.
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
                      // composer was open) keeps the words and thumbnails; the
                      // reason says what to do.
                      if (!result.ok && isString(result.error)) {
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
                      // The send is done once the queue has it; the clipboard
                      // mustn't hold the field. A browser stuck on a permission
                      // prompt never settles its write, and waiting on it once
                      // disabled the composer for good.
                      setSending(false);
                      bumpRequests();
                      st.notify({
                        kind: "request",
                        message: `Asked for a change to ${name}.`,
                        tone: "success",
                        ttl: TOAST_TTL.plain,
                      });
                      // The copy result replaces that line whenever it settles,
                      // since toasts of one kind replace each other.
                      void copyText(result.prompt).then((outcome) => {
                        st.notify({
                          kind: "request",
                          // A blocked clipboard costs nothing: the request is
                          // queued, and draining the queue is what the prompt
                          // was written for.
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
                {/* One surface, like every familiar composer: what to change
                    on top, who runs it and send below, in one border. The
                    field's focus ring stands for the whole. */}
                <div
                  className={`rounded-md border bg-[#2E2E2E]/40 transition-colors ${
                    dropping
                      ? "border-[#7C9CFF]/70 ring-1 ring-[#7C9CFF]/40"
                      : "border-[#232328] focus-within:border-[#D1D5DB]/40 focus-within:ring-1 focus-within:ring-[#D1D5DB]/40"
                  }`}
                  onDragEnter={(event) => {
                    if (briefing || !carriesFiles(event.dataTransfer.types)) return;
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
                    if (briefing || !carriesFiles(event.dataTransfer.types)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(event) => {
                    if (briefing || !carriesFiles(event.dataTransfer.types)) return;
                    event.preventDefault();
                    dropDepth.current = 0;
                    setDropping(false);
                    // Every dropped file goes through admission, so a PDF or
                    // SVG is refused with a reason, not ignored.
                    attachReferences(Array.from(event.dataTransfer.files));
                  }}
                >
                  {briefing ? (
                    <div className="flex items-center justify-between gap-2 pl-2.5 pr-1 pt-1">
                      {briefBase !== null ? (
                        <span className="min-w-0 truncate text-[10px] font-medium leading-5 text-[#84848C]">
                          Variations of {st.displayName(briefBase)}
                        </span>
                      ) : surfaces.length > 1 && briefSurface !== null ? (
                        <label className="flex items-center gap-1 text-[10px] font-medium leading-5 text-[#84848C]">
                          New
                          <select
                            aria-label="The surface to build directions for"
                            className="rounded bg-white/[0.06] px-1 text-[10px] font-medium text-[#D1D5DB] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
                            onChange={(event) => setPickedSurface(event.target.value)}
                            value={briefSurface}
                          >
                            {surfaces.map((surface) => (
                              <option key={surface} value={surface}>
                                {surface}
                              </option>
                            ))}
                          </select>
                          directions
                        </label>
                      ) : (
                        <span className="text-[10px] font-medium leading-5 text-[#84848C]">
                          {briefSurface === null
                            ? "New directions"
                            : `New ${briefSurface} directions`}
                        </span>
                      )}
                      <span className="flex min-w-0 shrink-0 items-center gap-0.5">
                        {/* The label on the left always says what Enter builds; this only switches it. */}
                        {likeTitle !== null &&
                          (briefBase !== null || briefSurface === activeSurface) && (
                            <button
                              aria-pressed={briefBase !== null}
                              className={`h-5 max-w-36 truncate rounded px-1.5 text-[10px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60 ${
                                briefBase === null
                                  ? "text-[#84848C] hover:bg-white/[0.06] hover:text-[#D1D5DB]"
                                  : "bg-white/[0.08] text-[#E8E8EA] hover:bg-white/[0.12]"
                              }`}
                              disabled={starting}
                              onClick={() => setBriefLike(briefBase === null)}
                              type="button"
                            >
                              More like {st.displayName(likeTitle)}
                            </button>
                          )}
                        <button
                          aria-label="Close the brief"
                          className="flex size-5 items-center justify-center rounded text-[#84848C] transition-colors hover:bg-white/[0.06] hover:text-white"
                          onClick={() => setBriefOpen(false)}
                          type="button"
                        >
                          <svg aria-hidden="true" height="10" viewBox="0 0 16 16" width="10">
                            <path
                              d="m4 4 8 8M12 4l-8 8"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeWidth="1.75"
                            />
                          </svg>
                        </button>
                      </span>
                    </div>
                  ) : (
                    <ReferenceStrip
                      drafts={references}
                      onRemove={removeReference}
                      onRetry={retryReference}
                    />
                  )}
                  {/* Enter sends, Shift+Enter breaks the line, as every chat
                      composer has taught. */}
                  <textarea
                    aria-label={
                      briefing
                        ? briefBase !== null
                          ? `Say what the variations of ${st.displayName(briefBase)} should vary, or leave it to ${briefAgentName}`
                          : briefSurface === null
                            ? `Describe the new directions for ${briefAgentName} to build`
                            : `Describe the new ${briefSurface} directions for ${briefAgentName} to build`
                        : gridding
                          ? "Open one of the directions to ask for a change"
                          : st.active
                            ? `Ask your agent to change the ${st.displayName(st.active)} direction`
                            : "Ask your agent to change a direction"
                    }
                    className="block w-full resize-none overflow-y-auto bg-transparent px-2.5 pb-1 pt-2 text-xs leading-4 text-white placeholder:text-[#84848C] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={briefing ? starting : sending || !st.active || gridding}
                    onChange={(event) => {
                      if (briefing) {
                        setBrief(event.target.value);

                        return;
                      }

                      // The first character is a second signal, for a composer
                      // that kept focus through the idle window.
                      if (intent === "" && event.target.value !== "") warmChosenAgent();
                      setIntent(event.target.value);
                    }}
                    onFocus={briefing ? undefined : warmChosenAgent}
                    onKeyDown={(event) => {
                      // Escape leaves the brief and keeps its draft for next time.
                      if (briefing && event.key === "Escape") {
                        event.preventDefault();
                        setBriefOpen(false);

                        return;
                      }

                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    onPaste={(event) => {
                      if (briefing) return;
                      const files = Array.from(event.clipboardData.files);

                      if (files.length === 0) return;
                      // A pasted image is the request; the text beside it is a
                      // filename nobody typed.
                      event.preventDefault();
                      attachReferences(files);
                    }}
                    placeholder={
                      briefing
                        ? briefBase !== null
                          ? "What should they vary? Optional"
                          : briefSurface === null
                            ? "Pick a direction on the surface first"
                            : "What should they explore?"
                        : gridding
                          ? "Open one of them to ask for a change"
                          : st.active === null
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
                    value={briefing ? brief : intent}
                  />
                  {briefing && briefAgent !== null && (
                    // Codex took about half as long again as Claude for the same set.
                    <p className="px-2.5 text-[10px] leading-4 text-[#84848C]">
                      Runs on your {briefAgentName} plan. Usually{" "}
                      {briefAgent === "codex" ? "two or three minutes" : "a minute or two"}.
                    </p>
                  )}
                  {briefing ? (
                    <BriefToolbar
                      count={briefCount}
                      onCount={setBriefCount}
                      agent={briefAgentName}
                      picker={briefAgent === null ? agentPicker : null}
                      reason={briefReason}
                      ready={(brief.trim() !== "" || briefBase !== null) && buildSurface !== null}
                      starting={starting}
                    />
                  ) : (
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
                      {agentPicker}
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
                  )}
                </div>
              </form>
            )}

            {sending ? (
              /*
               * Sending takes a second or two while Leglas loads the direction
               * headlessly so the agent sees what the user sees. Said in words,
               * since a quiet field reads as a hang. Takes the provenance
               * line's slot.
               */
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
            {/* One quiet line under the composer, only when needed: the way
                back to hidden tools, or that a terminal watcher holds the
                queue. */}
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
        className={`relative min-w-0 flex-1 ${
          gridding ? "grid gap-px bg-[#232328]" : splitting ? "flex" : "overflow-auto"
        }`}
        ref={attachStage}
        style={
          gridding
            ? {
                gridTemplateColumns: `repeat(${gridLayout.columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${gridLayout.rows}, minmax(0, 1fr))`,
              }
            : undefined
        }
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
            cover={(() => {
              const view = buildEnabled ? slotFor(title) : undefined;

              if (view === undefined || view.slot.state === "ready") return null;
              const actions = slotActions(view);

              return (
                <GenerationCover
                  acting={actions.acting}
                  agent={agentName(view.job.agent)}
                  name={st.displayName(title)}
                  onReplace={actions.onReplace}
                  onRetry={actions.onRetry}
                  onStop={actions.onStop}
                  slot={view.slot}
                />
              );
            })()}
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
            onShowAnyway={() => {
              framesAnyway.current.add(st.urlFor(title));
              setRefused((current) =>
                Object.fromEntries(Object.entries(current).filter(([key]) => key !== title)),
              );
            }}
            onStartBranch={() => st.startBranch(title)}
            onOpen={
              gridding
                ? () => {
                    setGrid(null);
                    st.setActive(title);
                  }
                : null
            }
            order={stagePlace.get(title) ?? -1}
            paneScale={paneScale}
            refusal={refused[title] ?? null}
            scaling={scaling}
            second={!gridding && title === compare}
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

          {/* Switched off, the button leaves the stage but returns while the
              popover is open, since the popover anchors to it and holds the
              switch to undo it. */}
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

      {/* Above the rail's footer when there's a rail, else just clear of the
          collapsed strip. */}
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
