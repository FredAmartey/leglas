import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import {
  ErrorOverlay,
  ICON_BUTTON,
  Mark,
  P,
  PIcon,
  RenameForm,
  SkeletonOverlay,
  Switch,
  Tip,
  Toasts,
  Wordmark,
} from "./kit.js";
import { copyText } from "./clipboard.js";
import { searchCap, shortcutList } from "./keymap.js";
import { MOOD } from "./orb.js";
import { INITIAL_HEALTH, nextHealthState, type HealthState } from "./health.js";
import { nextCompare, paneGeometry, paneTitles } from "./compare.js";
import { BADGE_CSS, NEXT_BADGE_CSS } from "./overlays.js";
import { paintSample, renderedSignature, twinsOf } from "./rendered.js";
import { scanQueue } from "./scan.js";
import { clampWidget, dragAnchor, isDrag, nearestCorner } from "./widget.js";
import { EASE } from "./prefs.js";
import { TOAST_TTL } from "./toasts.js";
import { useShellState } from "./useShellState.js";
import type { Preview } from "./types.js";
import {
  requestStatusLine,
  type AgentStatus,
  type RequestStatus,
  type RequestStatusDecision,
} from "./request-status.js";
import {
  cancelAgentRun,
  chooseAgent,
  readAgents,
  retryFailedRequest,
  type AgentsPayload,
} from "./agent-api.js";

/**
 * The Leglas chrome. Warm dark surfaces (#1C1C20 main, #1E1E22 strips,
 * #232328 borders, #2E2E2E inputs), a 368px rail, two type tiers, flat rows
 * with a sliding highlight and a hover-revealed action cluster, drag to
 * reorder, hidden scrollbars, no top bar, and a floating widget whose popover
 * holds the typeface picker, viewport presets, copy, and open-in-tab.
 *
 * The typeface is a user preference, not a design variant.
 */
const FONTS = [
  { key: "satoshi", label: "Satoshi", stack: "var(--font-satoshi)" },
  { key: "outfit", label: "Outfit", stack: "var(--font-outfit)" },
  { key: "geist", label: "Geist", stack: "var(--font-geist)" },
] as const;

/**
 * Tag pills colour themselves from their text: bright accents spaced around
 * the wheel, all at the same saturation so no tag reads as more important
 * than another. The same text lands on the same colour every session, so
 * nobody configures a palette. Amber is left out; it means "duplicate" here.
 */
const TAG_TONES = ["#34D399", "#38BDF8", "#818CF8", "#C084FC", "#FB7185", "#FB923C"] as const;

function tagTone(tag: string) {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const tone = TAG_TONES[Math.abs(hash) % TAG_TONES.length] ?? TAG_TONES[0];
  // Text at full strength on a 13% wash of itself, so the pill glows a
  // little against the dark rail instead of sitting flat on it.
  return { backgroundColor: `${tone}22`, color: tone };
}

/** How long a preview may take before it is treated as failed. */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * The rail's foot — the change composer and the share strip under it — which
 * toasts stack on top of rather than over.
 */
const RAIL_FOOTER_H = 86;

const IDLE_AGENT: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
};

const EMPTY_AGENTS: AgentsPayload = {
  agents: [],
  choice: null,
  customRun: null,
};

/** Whether to write the search chord as Cmd or Ctrl. Read once, never changes. */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const SEARCH_CAP = searchCap(IS_MAC);

/**
 * The keymap, on ? and from the tools popover.
 *
 * It reads SHORTCUTS rather than restating the bindings, so the list cannot
 * describe a key that no longer does anything. Defined here rather than inside
 * Shell so it is not a new component type on every render.
 */
function HelpOverlay({ mac, onClose }: { mac: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const shortcuts = shortcutList(mac);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        className="w-full max-w-sm rounded-lg border border-[#232328] bg-[#1E1E22] p-4 shadow-2xl focus:outline-none"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <span className="block pb-3 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
          Keyboard
        </span>
        <dl className="flex flex-col gap-2.5">
          {shortcuts.map((shortcut) => (
            <div className="flex items-baseline justify-between gap-4" key={shortcut.label}>
              <dt className="flex shrink-0 items-baseline gap-1">
                {shortcut.keys.map((cap, index) => (
                  <span className="flex items-baseline gap-1" key={cap}>
                    {index > 0 && shortcut.join ? (
                      <span className="text-[10px] text-[#84848C]">{shortcut.join}</span>
                    ) : null}
                    <kbd className="rounded border border-[#232328] bg-[#2E2E2E]/60 px-1.5 py-0.5 font-sans text-[11px] text-[#E8E8EA]">
                      {cap}
                    </kbd>
                  </span>
                ))}
              </dt>
              <dd className="text-right text-xs leading-snug text-[#9CA3AF]">{shortcut.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

type Drag = {
  dy: number;
  from: number;
  /** Gap between rows, measured at drag start so shifts clear it. */
  gap: number;
  /** Dragged row height, captured at drag start for render-time shifts. */
  height: number;
  title: string;
  /** After release: easing into the target slot before the order commits. */
  settling: boolean;
  started: boolean;
  to: number;
};

export function Shell({ previews, project }: { previews: Preview[]; project: string }) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef<HTMLInputElement | null>(null);
  const splitRef = useRef<(() => void) | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Stable, so the window key listener attaches once rather than on every
  // render of the shell.
  const onToggleSplit = useCallback(() => splitRef.current?.(), []);
  const onToggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const [widgetOpen, setWidgetOpen] = useState(false);
  // The way into the tools when the widget is switched off the stage.
  const onToggleTools = useCallback(() => setWidgetOpen((open) => !open), []);
  const st = useShellState({
    previews,
    project,
    searchRef,
    onToggleSplit,
    onToggleHelp,
    onToggleTools,
    // While the keymap is on screen it is the subject, not a way to drive what
    // is behind it. ? still closes it.
    suspended: helpOpen,
  });
  const [searchFocused, setSearchFocused] = useState(false);
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
  const [sending, setSending] = useState(false);
  const [pickingAgent, setPickingAgent] = useState<string | null>(null);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [requestAction, setRequestAction] = useState<"cancel" | "retry" | null>(null);
  const widgetButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // One white/6% panel behind the hovered row that eases between rows. The
  // active row carries its own persistent surface, so this is hover-only.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [glow, setGlow] = useState({ height: 0, on: false, top: 0 });

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
  const dragMeta = useRef<{
    maxDy: number;
    minDy: number;
    rows: { height: number; mid: number; title: string; top: number }[];
    startY: number;
    suppressed: boolean;
  } | null>(null);

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
      setDrag((current) => {
        if (!current || current.settling) return current;
        if (!current.started && Math.abs(dy) <= 4) return { ...current, dy };
        if (!current.started) window.getSelection()?.removeAllRanges();
        const row = meta.rows[current.from];
        if (!row) return current;
        // Follow the pointer within the slot range plus one row of give, so
        // the row never detaches into empty space; the target index still
        // follows the raw pointer.
        const bounded = Math.max(meta.minDy, Math.min(meta.maxDy, dy));
        const center = row.mid + dy;
        let to = 0;
        meta.rows.forEach((candidate, index) => {
          if (index !== current.from && center > candidate.mid) to += 1;
        });
        return { ...current, dy: bounded, started: true, to };
      });
    };
    const onUp = () => {
      const current = dragRef.current;
      if (!current?.started) {
        setDrag(null);
        return;
      }
      meta.suppressed = true;
      // Ease the dragged row the rest of the way into its slot (the others are
      // already shifted to receive it), then commit so the swap has no snap.
      let settle = 0;
      if (current.to > current.from) {
        for (let index = current.from + 1; index <= current.to; index += 1) {
          settle += (meta.rows[index]?.height ?? 0) + current.gap;
        }
      } else {
        for (let index = current.to; index < current.from; index += 1) {
          settle -= (meta.rows[index]?.height ?? 0) + current.gap;
        }
      }
      setDrag({ ...current, dy: settle, settling: true });
      window.setTimeout(() => {
        st.moveOption(current.title, current.to);
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
  const ROW_BUTTON =
    "flex h-7 w-full items-center justify-between gap-2 whitespace-nowrap rounded px-2 text-xs hover:bg-[#2E2E2E] hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

  const activeFont = FONTS.find((font) => font.key === st.prefs.font) ?? FONTS[0];
  const framed = st.prefs.viewport !== null;
  /** The `p-6` breathing room a framed preset sits in, both sides. */
  const FRAME_GUTTER = 48;
  const dragging = drag?.started ?? false;
  // Dragging the widget counts as busy too: a preview that keeps taking the
  // pointer lights up its own hover states under a drag that is not for it.
  const busy = st.resizing || dragging || widgetDragging;

  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const [reloadTick, setReloadTick] = useState<Record<string, number>>({});

  // Flipping shows a difference over time; a split shows it at once, which is
  // what you want for the last two directions still in contention.
  const [split, setSplit] = useState(false);
  const [comparePin, setComparePin] = useState<string | null>(null);
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
  const splitting = visible.length > 1;
  // Panes mount when first activated, so a direction compared against without
  // ever having been opened would have nothing to render. Anything on stage
  // has to be mounted whether or not it was ever the active one.
  const mounted = [...new Set([...st.panes, ...visible])];

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
  const [requestSnapshot, setRequestSnapshot] = useState<{
    requests: RequestStatus[];
    agent: AgentStatus;
  }>({ requests: [], agent: IDLE_AGENT });
  const [agentState, setAgentState] = useState<AgentsPayload>(EMPTY_AGENTS);
  const [agentsTick, refreshAgents] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let cancelled = false;
    void readAgents()
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
  }, [agentsTick]);
  // Bumped after a submit so the hint updates without waiting out the
  // interval; the effect restarting is the immediate poll.
  const [requestsTick, bumpRequests] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    // Guard per effect run, like the health poll below: a shared flag would be
    // reset by a remount while the torn-down run's fetch is still in flight,
    // and that response must not land.
    let cancelled = false;
    const poll = () =>
      fetch("/leglas/api/requests")
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
        .catch(() => {});
    const timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [requestsTick]);
  const computedRequestDecision = requestStatusLine(
    requestSnapshot.requests,
    requestSnapshot.agent,
    agentState.choice,
    agentState.agents,
    st.prefs.agentPickerDismissed,
  );
  const decisionKey = JSON.stringify(computedRequestDecision);
  const shownRequestDecision = useRef<{
    key: string;
    value: RequestStatusDecision;
  }>({ key: decisionKey, value: computedRequestDecision });
  if (shownRequestDecision.current.key !== decisionKey) {
    shownRequestDecision.current = { key: decisionKey, value: computedRequestDecision };
  }
  const requestDecision = shownRequestDecision.current.value;
  useEffect(() => {
    if (requestDecision.kind !== "ready") setSwitchingAgent(false);
  }, [requestDecision.kind]);
  const showAgentChoices =
    requestDecision.kind === "picker" ||
    (requestDecision.kind === "ready" && switchingAgent);
  const pickAgent = (agent: string) => {
    if (pickingAgent !== null) return;
    setPickingAgent(agent);
    void chooseAgent(agent)
      .then(() => {
        refreshAgents();
        setSwitchingAgent(false);
      })
      .catch(() => {
        st.notify({
          kind: "agent-choice",
          message: "That agent could not be selected. No run started.",
          tone: "danger",
          ttl: TOAST_TTL.action,
        });
      })
      .finally(() => setPickingAgent(null));
  };
  const cancelRequest = () => {
    if (requestAction !== null) return;
    setRequestAction("cancel");
    void cancelAgentRun()
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
  const loadedRef = useRef(st.loaded);
  loadedRef.current = st.loaded;

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      fetch("/leglas/api/health")
        .then((response) => response.json() as Promise<{ reachable: boolean }>)
        .then(({ reachable }) => {
          if (!cancelled) setHealth((current) => nextHealthState(current, reachable));
        })
        .catch(() => {
          // Leglas itself is unreachable; that is not the dev server's fault
          // and the page will fail visibly enough on its own.
        });
    const timer = window.setInterval(poll, 3000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Once it answers again, reload what broke rather than making the user click
  // through every pane.
  useEffect(() => {
    if (!health.reachable || !health.wasDown) return;
    setErrored({});
    setReloadTick((current) => {
      const next = { ...current };
      for (const title of Object.keys(loadedRef.current)) {
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
  const [signatures, setSignatures] = useState<Record<string, string | null>>({});
  const twins = twinsOf(signatures);

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

  const readRendered = (title: string, frame: HTMLIFrameElement) => {
    // Cross-origin panes are unreadable by design; a branch preview or a
    // deployed URL simply goes uncompared.
    let doc: Document | null = null;
    try {
      doc = frame.contentDocument;
    } catch {
      return;
    }
    if (!doc?.body) return;

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
    const signature = renderedSignature(doc.body.innerText ?? "", tags, paint);
    setSignatures((current) =>
      current[title] === signature ? current : { ...current, [title]: signature },
    );
  };

  /**
   * The duplicate check without waiting for clicks.
   *
   * Signatures used to come only from panes the user had opened, so "Same as"
   * appeared one click at a time, after the judgment it exists to protect.
   * Unopened previews are read here instead: one hidden off-stage frame walks
   * them sequentially, records each signature, and unmounts. One at a time
   * keeps the cost to a single extra app instance, briefly, per direction.
   *
   * The frame is parked off-viewport rather than display:none, because a
   * hidden document lays out nothing and reads as empty. It only runs while
   * the dev server answers: scanning a down server would record N failures.
   */
  const scanning = health.reachable ? (scanQueue(previews, signatures, mounted)[0] ?? null) : null;

  /**
   * Whether a row's duplicate verdict is still being earned. Verdicts are
   * re-derived from real renders every session, precisely because the agent
   * edits these pages between visits, so for a few seconds after load the
   * honest state of a row is still cooking, and saying so quietly is what
   * keeps a tag that appears late from reading as a glitch.
   */
  const checking = (title: string) =>
    health.reachable && !(title in signatures) && st.urlFor(title).startsWith("/");

  // A hung navigation would stall the walk, so a scan that produces nothing
  // within the pane timeout records the null verdict and the queue moves on.
  useEffect(() => {
    if (scanning === null) return;
    const timer = window.setTimeout(() => {
      setSignatures((current) =>
        scanning in current ? current : { ...current, [scanning]: null },
      );
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [scanning]);

  const onScanLoad = (title: string, frame: HTMLIFrameElement) => {
    // The stage reads panes with the overlay preference applied, and a hidden
    // badge leaves the text. The scan has to read through the same lens or
    // one page would produce two signatures depending on who read it.
    applyOverlayPref(frame, !st.prefs.showDevOverlays);
    window.setTimeout(() => {
      applyOverlayPref(frame, !st.prefs.showDevOverlays);
      let readable = false;
      try {
        readable = frame.contentDocument != null;
      } catch {
        readable = false;
      }
      if (readable) readRendered(title, frame);
      // Unreadable means a failed navigation; the null verdict moves the
      // queue on instead of retrying forever.
      else setSignatures((current) => ({ ...current, [title]: null }));
    }, 600);
  };

  useEffect(() => {
    if (st.loaded[st.active] || errored[st.active]) return;
    // A known-down dev server needs no waiting: the answer is already in.
    const wait = health.reachable ? LOAD_TIMEOUT_MS : 0;
    const timer = setTimeout(
      () => setErrored((current) => ({ ...current, [st.active]: true })),
      wait,
    );
    return () => clearTimeout(timer);
  }, [st.active, st.loaded, errored, reloadTick, health.reachable]);

  const reloadPane = (title: string) => {
    setErrored((current) => ({ ...current, [title]: false }));
    st.resetLoaded(title);
    setReloadTick((current) => ({ ...current, [title]: (current[title] ?? 0) + 1 }));
  };

  const onRowPointerDown =
    (title: string, index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (st.renaming || st.query.trim() || st.rows.length < 2) return;
      // Buttons keep their clicks; the note keeps text selection.
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
      dragMeta.current = {
        maxDy: rowRect ? view.bottom - rowRect.bottom : 0,
        minDy: rowRect ? view.top - rowRect.top : 0,
        rows,
        startY: event.clientY,
        suppressed: false,
      };
      const first = rows[0];
      const second = rows[1];
      setDrag({
        dy: 0,
        from: index,
        gap: first && second ? second.top - first.top - first.height : 0,
        height: rows[index]?.height ?? 0,
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

  /**
   * The design by itself in a new tab. A preview URL is the app's own URL, so
   * what opens is the direction filling the window with none of this chrome
   * around it — the closest thing to seeing it shipped.
   */
  const openAlone = (title: string) => {
    window.open(st.urlFor(title), "_blank", "noopener,noreferrer");
  };

  const renderRow = (title: string, index: number) => {
    const isActive = title === st.active;
    const preview = st.previewFor(title);
    const isDragged = dragging && drag?.title === title;
    const shift = dragging && !isDragged ? shiftFor(index) : 0;
    const meta = st.rowMeta.get(title);
    const isVariant = meta?.depth === 1;
    const variantCount = meta?.variants ?? 0;
    const folded = meta?.folded ?? false;
    // Renaming edits the name where it sits. Replacing the whole row with a
    // form meant every neighbour moved, the note vanished, and the row you
    // were aiming at stopped looking like itself. The field carries the
    // title's own metrics instead, so nothing below it shifts by a pixel.
    const renamingThis = st.renaming === title;

    return (
      <li
        className={`group relative ${
          isDragged
            ? `z-30 rounded-md bg-white/[0.06] shadow-2xl ${
                drag?.settling
                  ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
                  : ""
              }`
            : "z-10"
        } ${
          dragging && !isDragged
            ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
            : ""
        }`}
        data-title={title}
        key={title}
        onPointerEnter={(event) =>
          setGlow({
            height: event.currentTarget.offsetHeight,
            on: true,
            top: event.currentTarget.offsetTop,
          })
        }
        style={
          isDragged
            ? { transform: `translateY(${drag?.dy ?? 0}px)` }
            : shift
              ? { transform: `translateY(${shift}px)` }
              : undefined
        }
      >
        <div
          aria-pressed={isActive}
          className={`relative flex w-full cursor-grab items-start gap-2 rounded-md py-2 pr-3 text-left transition-colors active:cursor-grabbing ${
            isVariant ? "pl-11" : "pl-3"
          } ${isActive ? "bg-[#2E2E2E] ring-1 ring-inset ring-[#D1D5DB]/40" : ""}`}
          onClick={() => {
            if (renamingThis) return;
            if (dragMeta.current?.suppressed) {
              dragMeta.current.suppressed = false;
              return;
            }
            st.setActive(title);
          }}
          onDoubleClick={(event) => {
            // The whole card opens the design, and only two things carve out
            // of it: the buttons, which have their own jobs, and the name,
            // which stops the event itself. Everything else — the note, the
            // badge, the empty space beside them — is one target.
            if (renamingThis) return;
            if ((event.target as HTMLElement).closest("button")) return;
            // The second click of the pair has already selected a word.
            window.getSelection()?.removeAllRanges();
            openAlone(title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              st.setActive(title);
            }
          }}
          onPointerDown={onRowPointerDown(title, index)}
          role="button"
          tabIndex={0}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              {variantCount > 0 && (
                <Tip label={folded ? `Show ${variantCount} variant${variantCount === 1 ? "" : "s"}` : "Fold the variants away"}>
                  <button
                    aria-expanded={!folded}
                    aria-label={`${folded ? "Show" : "Hide"} the variants of ${st.displayName(title)}`}
                    className="-ml-1 flex shrink-0 items-center gap-1 rounded px-0.5 py-1 text-[#84848C] transition-colors hover:text-[#E8EAED]"
                    onClick={(event) => {
                      event.stopPropagation();
                      st.toggleFamily(title);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    <svg
                      className={`size-2.5 transition-transform duration-150 motion-reduce:transition-none ${folded ? "-rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 10 10"
                    >
                      <path d="M2 3.5 5 6.5 8 3.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {folded ? (
                      <span className="text-[10px] leading-none tabular-nums">{variantCount}</span>
                    ) : null}
                  </button>
                </Tip>
              )}
              {renamingThis ? (
                <RenameForm
                  error={st.renameError}
                  initial={st.displayName(title)}
                  label={`Rename the ${st.displayName(title)} direction`}
                  onCancel={() => st.startRename(null)}
                  onCommit={(value, via) => st.rename(title, value, via)}
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 text-sm font-medium leading-5 transition-colors duration-150 ${
                    isActive ? "text-white" : "text-[#D1D5DB] group-hover:text-[#E8EAED]"
                  }`}
                >
                  {/* Two targets share this row and the split between them is
                      the whole trick. The outer box is flex-1, so hanging the
                      gesture there made most of the card rename instead of
                      open. Hanging it on the glyphs alone was the other
                      extreme: a four-character name is a sliver to hit.

                      So the name gets a box of its own — at least 70% of the
                      line the rename field will fill, growing to fit a longer
                      name. Each padding is cancelled by an equal negative
                      margin, which buys territory without moving a pixel of
                      text or changing the row's height. It reaches into the
                      left gutter, where there is nothing to take it from,
                      except on a family root where the fold control is
                      already sitting there. What is left for opening the
                      design is the note beneath, the badge, and the last
                      third of the title line. */}
                  <span
                    className={`block w-fit min-w-[70%] max-w-full cursor-text select-text truncate -my-1 py-1 pr-2 ${
                      variantCount > 0 ? "" : "-ml-3 pl-3"
                    }`}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      window.getSelection()?.removeAllRanges();
                      st.startRename(title);
                    }}
                  >
                    {st.displayName(title)}
                  </span>
                </span>
              )}
              {splitting && title === compare ? (
                <span
                  className={`shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium leading-normal text-[#E8E8EA] transition-opacity duration-150 ${
                    dragging
                      ? ""
                      : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                  }`}
                >
                  Comparing
                </span>
              ) : twins[title] ? (
                <Tip
                  label={`Renders the same page as ${twins[title]?.join(", ")}. Check the URL.`}
                >
                  <span
                    className={`shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-normal text-amber-300/90 transition-opacity duration-150 ${
                      dragging
                        ? ""
                        : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                    }`}
                  >
                    Same as {twins[title]?.length === 1 ? twins[title]?.[0] : `${twins[title]?.length} others`}
                  </span>
                </Tip>
              ) : checking(title) ? (
                <span
                  className={`flex h-5 shrink-0 items-center gap-1 rounded bg-white/[0.04] pl-0.5 pr-1.5 text-[10px] font-medium leading-none text-[#84848C]/80 transition-opacity duration-150 ${
                    dragging
                      ? ""
                      : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                  }`}
                >
                  <ThinkingOrb aria-label="Checking for duplicates" size={20} state={MOOD} theme="dark" />
                  Cooking
                </span>
              ) : (
                preview?.tags[0] && (
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-normal transition-opacity duration-150 ${
                      dragging
                        ? ""
                        : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                    }`}
                    style={tagTone(preview.tags[0])}
                  >
                    {preview.tags[0]}
                  </span>
                )
              )}
            </span>
            {/* A refused name takes this line rather than adding one. The two
                are never both worth reading, and swapping them keeps the row
                the height it already was. */}
            <span
              className={`mt-0.5 line-clamp-2 block cursor-text select-text text-xs leading-snug transition-colors ${
                renamingThis && st.renameError
                  ? "text-amber-300/90"
                  : isActive
                    ? "text-[#D1D5DB]"
                    : "text-[#84848C]"
              }`}
              data-selectable=""
              id={renamingThis && st.renameError ? "leglas-rename-error" : undefined}
            >
              {renamingThis && st.renameError ? st.renameError : (preview?.note ?? preview?.url)}
            </span>
          </span>
        </div>
        <div
          className={`pointer-events-none absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ${
            renamingThis ? "invisible" : ""
          } ${
            dragging
              ? ""
              : "group-hover:pointer-events-auto group-hover:opacity-100 group-has-[button:focus-visible]:pointer-events-auto group-has-[button:focus-visible]:opacity-100"
          }`}
        >
          {/* Choosing the second direction belongs where the directions are.
              The active row is the left pane, so this only appears on the
              others. */}
          {title !== st.active && (
            <Tip
              label={
                splitting && title === compare
                  ? "Stop comparing"
                  : `Compare with ${st.displayName(st.active)}`
              }
            >
              <button
                aria-label={
                  splitting && title === compare
                    ? `Stop comparing ${st.displayName(title)}`
                    : `Compare ${st.displayName(title)} with ${st.displayName(st.active)}`
                }
                aria-pressed={splitting && title === compare}
                className={`${ICON_BUTTON} ${
                  splitting && title === compare ? "text-white" : ""
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (splitting && title === compare) {
                    setSplit(false);
                    return;
                  }
                  setComparePin(title);
                  setSplit(true);
                }}
                type="button"
              >
                <PIcon d={P.split} />
              </button>
            </Tip>
          )}
          {/* The reflex copy: someone says "show me" and this goes into the
              message. The reference, which says what the direction is, is the
              deliberate one and lives under the rail. */}
          <Tip
            label={
              st.copied?.kind === "link" && st.copied.title === title
                ? "Copied"
                : "Copy preview link"
            }
          >
            <button
              aria-label={`Copy the preview link to the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.copyLink(title)}
              type="button"
            >
              {st.copied?.kind === "link" && st.copied.title === title ? (
                <span className="text-[10px] text-emerald-300">✓</span>
              ) : (
                <PIcon d={P.link} />
              )}
            </button>
          </Tip>
          <Tip label="Rename">
            <button
              aria-label={`Rename the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.startRename(title)}
              type="button"
            >
              <PIcon d={P.pencil} size={12} />
            </button>
          </Tip>
          <Tip label="Remove from list">
            <button
              aria-label={`Remove the ${st.displayName(title)} direction from the list`}
              className={ICON_BUTTON}
              onClick={() => st.hide(title)}
              type="button"
            >
              <PIcon d={P.trash} size={12} />
            </button>
          </Tip>
        </div>
      </li>
    );
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
          st.resizing
            ? ""
            : `transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
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
          <div className="z-10 flex shrink-0 items-center justify-between gap-2 border-b border-[#232328] bg-[#1E1E22] px-2.5 py-2.5">
            {/* The product names itself here rather than in the list below it:
                the search field and every command already say "directions". */}
            <span className="flex min-w-0 items-center gap-2">
              <Mark size={28} />
              <Wordmark height={18} />
            </span>
            <Tip
              label={
                <>
                  Collapse panel <kbd className="ml-1 text-[#9CA3AF]">[</kbd>
                </>
              }
              side="right"
            >
              <button
                aria-label="Collapse the directions panel"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#2E2E2E] hover:text-white"
                onClick={() => st.setPrefs((prefs) => ({ ...prefs, collapsed: true }))}
                type="button"
              >
                <PIcon d={P.sidebar} size={16} />
              </button>
            </Tip>
          </div>

          <div className="px-3 pb-1 pt-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#D1D5DB]">
                <PIcon d={P.search} />
              </span>
              {/* The hint steps aside once the field is in use, so it never
                  sits behind what is being typed. */}
              <kbd
                className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[#232328] bg-[#2E2E2E]/60 px-1.5 py-0.5 font-sans text-[10px] leading-none tracking-wide text-[#84848C] transition-opacity duration-150 motion-reduce:transition-none ${
                  st.query || searchFocused ? "opacity-0" : "opacity-100"
                }`}
              >
                {SEARCH_CAP}
              </kbd>
              <input
                aria-label="Search directions"
                className="w-full rounded-md border border-[#232328] bg-[#2E2E2E]/40 py-1.5 pl-7 pr-16 text-xs text-white placeholder:text-[#E8EAED] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/60"
                onBlur={() => setSearchFocused(false)}
                onFocus={() => setSearchFocused(true)}
                onChange={(event) => st.setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (st.query) st.setQuery("");
                  else event.currentTarget.blur();
                }}
                placeholder="Search directions…"
                ref={searchRef}
                type="text"
                value={st.query}
              />
            </div>
          </div>

          {!health.reachable && (
            <div className="mx-3 mb-1 mt-1 rounded-md border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-2">
              <p className="text-xs font-medium text-amber-300/90">Dev server not responding</p>
              <p className="mt-0.5 text-[11px] leading-snug text-[#9CA3AF]">
                Anything on screen is from before it stopped. Previews return on their own once
                it is back.
              </p>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ul
              className="relative flex flex-col gap-1"
              onPointerLeave={() => setGlow((current) => ({ ...current, on: false }))}
              ref={listRef}
            >
              <div
                aria-hidden
                className={`pointer-events-none absolute left-0 right-0 z-0 rounded-md bg-white/[0.06] transition-[transform,height,opacity] duration-150 ${EASE} motion-reduce:transition-none`}
                style={{
                  height: glow.height,
                  opacity: glow.on && !dragging ? 1 : 0,
                  transform: `translateY(${glow.top}px)`,
                }}
              />
              {st.rows.map((title, index) => renderRow(title, index))}
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
                    {st.visibleCount === 0 && st.hiddenCount > 0
                      ? "Every direction is removed. Restore one below."
                      : "No directions yet. Add them to leglas.config.ts."}
                  </p>
                )}
              </div>
            )}

            {st.hiddenCount > 0 && (
              <button
                className="mt-1 rounded px-3 py-1.5 text-left text-[11px] text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                onClick={() => st.setShowHidden((value) => !value)}
                type="button"
              >
                {st.showHidden ? "Hide" : "Show"} removed ({st.hiddenCount})
              </button>
            )}

            {st.showHidden && (
              <ul className="relative">
                {st.prefs.hidden.filter(st.matches).map((title) => (
                  <li className="group relative" key={title}>
                    <div className="flex items-center justify-between rounded-md px-3 py-2 transition-colors group-hover:bg-white/[0.04]">
                      <span className="truncate text-sm font-medium text-[#9CA3AF]">
                        {st.displayName(title)}
                      </span>
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
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Enter both queues the request and copies the prompt, so it works
              whether the agent drains the queue or the prompt gets pasted into
              a chat by hand. The confirmation is a toast rather than the
              placeholder it used to swap in, which vanished with the panel
              that carried it. */}
          <form
            className="px-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = intent.trim();
              const title = st.active;
              if (!value || !title || sending) return;
              const name = st.displayName(title);
              setSending(true);
              void fetch("/leglas/api/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title, intent: value }),
              })
                .then((response) => response.json() as Promise<{ ok: boolean; prompt?: string }>)
                .then(async (result) => {
                  if (!result.ok || !result.prompt) throw new Error("refused");
                  setIntent("");
                  bumpRequests();
                  // Said before the clipboard is touched, because the queue is
                  // the durable half and the clipboard is the half that can
                  // hang: a browser sitting on a permission prompt never
                  // settles either way, and a request that was accepted has to
                  // say so regardless. The copy then supersedes this line,
                  // since toasts of one kind replace rather than stack.
                  st.notify({
                    kind: "request",
                    message: `Asked for a change to ${name}.`,
                    tone: "success",
                    ttl: TOAST_TTL.plain,
                  });
                  const outcome = await copyText(result.prompt);
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
                })
                .catch(() => {
                  st.notify({
                    kind: "request",
                    message: `That request never reached Leglas. ${name} is unchanged.`,
                    tone: "danger",
                    ttl: TOAST_TTL.action,
                  });
                })
                .finally(() => setSending(false));
            }}
          >
            <input
              aria-label={
                st.active
                  ? `Ask your agent to change the ${st.displayName(st.active)} direction`
                  : "Ask your agent to change a direction"
              }
              className="w-full rounded-md border border-[#232328] bg-[#2E2E2E]/40 px-2.5 py-2 text-xs text-white transition-colors placeholder:text-[#84848C] focus:border-[#D1D5DB]/40 focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/40 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={sending || !st.active}
              onChange={(event) => setIntent(event.target.value)}
              placeholder={
                st.active ? `Change ${st.displayName(st.active)}…` : "No direction to change yet"
              }
              ref={requestRef}
              type="text"
              value={intent}
            />
          </form>

          <div className="flex h-11 items-center justify-between gap-2 px-3 py-1">
            {/* While the tools are switched off the composer hint gives its
                slot to the way back, so the toast is not the only sign. */}
            {st.prefs.showWidget ? (
              showAgentChoices ? (
                <div className="min-w-0 flex-1 text-[10px] leading-[10px] text-[#84848C]">
                  <span className="block truncate">Run changes with:</span>
                  {/* The agent names are the only actions in this slot, so they
                      get the pill treatment and the dismissal stays plain text:
                      same size, two different invitations. */}
                  <div className="flex h-4 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
                    {agentState.agents
                      .filter((agent) => agent.available)
                      .map((agent) => {
                        const active =
                          requestDecision.kind === "ready" && agent.id === agentState.choice;
                        return (
                          <button
                            aria-pressed={requestDecision.kind === "ready" ? active : undefined}
                            className="shrink-0 rounded border border-[#3A3A40] px-1.5 text-[10px] leading-[14px] text-[#D1D5DB] transition-colors hover:border-[#D1D5DB]/60 hover:text-white aria-pressed:border-[#D1D5DB]/60 aria-pressed:text-white disabled:cursor-wait disabled:opacity-40"
                            disabled={pickingAgent !== null}
                            key={agent.id}
                            onClick={() =>
                              active ? setSwitchingAgent(false) : pickAgent(agent.id)
                            }
                            type="button"
                          >
                            {agent.name}
                          </button>
                        );
                      })}
                    {requestDecision.kind === "ready" ? (
                      <button
                        className="shrink-0 rounded px-0.5 py-0.5 text-[10px] leading-3 text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                        onClick={() => setSwitchingAgent(false)}
                        type="button"
                      >
                        keep {requestDecision.name}
                      </button>
                    ) : (
                      <button
                        className="shrink-0 rounded px-0.5 py-0.5 text-[10px] leading-3 text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                        onClick={() =>
                          st.setPrefs((prefs) => ({ ...prefs, agentPickerDismissed: true }))
                        }
                        type="button"
                      >
                        I&apos;ll run my own
                      </button>
                    )}
                  </div>
                  <span
                    className="block truncate text-[#84848C]"
                    title="Runs here with write access, like in your terminal."
                  >
                    Runs here with write access, like in your terminal.
                  </span>
                </div>
              ) : requestDecision.kind === "ready" ? (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="min-w-0 truncate text-[10px] leading-snug text-[#84848C]">
                    Enter sends it to {requestDecision.name}
                  </span>
                  <button
                    className="shrink-0 rounded px-0.5 py-0.5 text-[10px] leading-3 text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                    onClick={() => setSwitchingAgent(true)}
                    type="button"
                  >
                    switch
                  </button>
                </div>
              ) : requestDecision.kind === "status" ? (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  {requestDecision.failedId !== null ? (
                    <button
                      className="min-w-0 truncate rounded text-left text-[10px] leading-snug text-[#84848C] transition-colors hover:text-[#D1D5DB] disabled:cursor-wait disabled:opacity-40"
                      disabled={requestAction !== null}
                      onClick={() => retryRequest(requestDecision.failedId as string)}
                      type="button"
                    >
                      {requestDecision.text}
                    </button>
                  ) : (
                    <span
                      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[10px] leading-snug text-[#84848C] [direction:rtl]"
                      title={requestDecision.text}
                    >
                      <bdi dir="ltr">{requestDecision.text}</bdi>
                    </span>
                  )}
                  {requestDecision.cancellable ? (
                    <button
                      aria-label="Stop this run"
                      className="shrink-0 rounded px-0.5 text-[13px] leading-none text-[#84848C] transition-colors hover:text-[#D1D5DB] disabled:cursor-wait disabled:opacity-40"
                      disabled={requestAction !== null}
                      onClick={cancelRequest}
                      title="Stop this run"
                      type="button"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ) : (
                <span className="min-w-0 truncate text-[10px] leading-snug text-[#84848C]">
                  Enter queues it for <span className="font-medium">npx leglas requests</span>
                </span>
              )
            ) : (
              <button
                className="min-w-0 truncate rounded text-left text-[10px] leading-snug text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                onClick={() => setWidgetOpen(true)}
                type="button"
              >
                Bring the tools back <kbd className="font-sans text-[#9CA3AF]">T</kbd>
              </button>
            )}
            {/* Named for what lands on the clipboard rather than for the
                gesture: "Share" said nothing about how it differs from the
                copy button on every row, which is now the plain link. */}
            <Tip
              label={
                <>
                  <span className="block">Copy a detailed reference.</span>
                  <span className="block">For a teammate or an agent.</span>
                </>
              }
            >
              <button
                aria-label={`Copy a reference to the ${st.displayName(st.active)} direction`}
                className="shrink-0 rounded-md bg-[#2E2E2E]/60 px-3.5 py-1.5 text-xs font-medium text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E] hover:text-white"
                onClick={() => st.copyReference(st.active)}
                type="button"
              >
                {st.copied?.kind === "reference" && st.copied.title === st.active
                  ? "Copied"
                  : "Copy reference"}
              </button>
            </Tip>
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
          <div
            className={
              !visible.includes(title)
                ? "hidden"
                : splitting
                  ? `relative min-w-0 flex-1 overflow-auto ${
                      title === compare ? "border-l border-[#232328]" : ""
                    } ${
                      scaling
                        ? "flex flex-col items-center justify-center gap-2.5"
                        : framed
                          ? "flex min-h-full justify-center p-6"
                          : ""
                    }`
                  : framed
                    ? "flex min-h-full justify-center p-6"
                    : "absolute inset-0"
            }
            key={title}
            style={splitting ? { order: visible.indexOf(title) } : undefined}
          >
            {splitting && (
              // Two panes need naming; one does not, because the rail already
              // shows which is active.
              // Scaled, the name belongs to its artboard and sits on top of
              // it; floating at the top of the pane leaves it stranded above
              // the space the letterboxing opens up.
              <div
                className={
                  scaling
                    ? "pointer-events-none z-10 flex justify-center"
                    : "pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3"
                }
              >
                <span className="rounded-full bg-[#1C1C20]/85 px-2.5 py-1 text-[11px] font-medium text-[#E8E8EA] shadow-lg backdrop-blur">
                  {st.displayName(title)}
                  {/* Say the scale rather than let it be guessed from the type
                      looking small. The width is the useful half: it is what
                      the design is actually being drawn at. */}
                  {scaling && (
                    <span className="ml-1.5 font-normal text-[#8E8E96]">
                      {Math.round(designWidth)}px · {Math.round(paneScale * 100)}%
                    </span>
                  )}
                </span>
              </div>
            )}
            <div
              className={
                scaling
                  ? // Its own artboard, so the room around it reads as canvas
                    // rather than as a pane that failed to fill.
                    "relative shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.12)]"
                  : framed
                    ? `relative h-[calc(100dvh-48px)] shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.10)] transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
                    : "relative size-full"
              }
              style={
                scaling
                  ? { height: boxHeight, width: boxWidth }
                  : framed
                    ? { width: st.prefs.viewport ?? undefined }
                    : undefined
              }
            >
              {/*
                The frame keeps its own dimensions and is scaled as a whole, so
                the app inside measures the width it was designed for. Media
                queries answer against that width, not against the pane, which
                is the entire point. Overlays stay outside this box: an error
                worth reading is not worth reading at half size.
              */}
              <div
                className={scaling ? "origin-top-left" : "size-full"}
                style={
                  scaling
                    ? {
                        height: frameHeight,
                        transform: `scale(${paneScale})`,
                        width: designWidth,
                      }
                    : undefined
                }
              >
              <iframe
                className={`size-full border-0 bg-white ${busy ? "pointer-events-none" : ""}`}
                key={reloadTick[title] ?? 0}
                onError={() => setErrored((current) => ({ ...current, [title]: true }))}
                onLoad={(event) => {
                  // A failed navigation still fires load but lands on an error
                  // document whose contentDocument reads as null or throws, so
                  // for same-origin previews readability is the signal.
                  //
                  // A preview served from another origin is never readable, so
                  // the same check would condemn every one of them: a branch
                  // preview on its own port, or a deployed URL. There, load is
                  // all the signal available.
                  const src = st.urlFor(title);
                  const sameOrigin = src.startsWith("/");
                  let ok = true;
                  if (sameOrigin) {
                    try {
                      ok = event.currentTarget.contentDocument != null;
                    } catch {
                      ok = false;
                    }
                  }
                  if (ok) {
                    st.markLoaded(title);
                    setErrored((current) => (current[title] ? { ...current, [title]: false } : current));
                    // A client-rendered app draws after load, so read once the
                    // frame has had a chance to paint rather than at load.
                    const frame = event.currentTarget;
                    applyOverlayPref(frame, !st.prefs.showDevOverlays);
                    window.setTimeout(() => {
                      applyOverlayPref(frame, !st.prefs.showDevOverlays);
                      readRendered(title, frame);
                    }, 600);
                  } else {
                    setErrored((current) => ({ ...current, [title]: true }));
                  }
                }}
                src={st.urlFor(title)}
                title={`Preview: ${st.displayName(title)}`}
              />
              </div>
              {errored[title] ? (
                <ErrorOverlay
                  onReload={() => reloadPane(title)}
                  reason={
                    health.reachable
                      ? `${st.urlFor(title)} didn’t respond.`
                      : "Your dev server stopped. This returns on its own once it is back."
                  }
                />
              ) : (
                <SkeletonOverlay loaded={Boolean(st.loaded[title])} />
              )}
              {/* A pane that loaded before the server died keeps showing that
                  render. Saying so is the difference between a stale preview
                  and a lie. */}
              {!health.reachable && st.loaded[title] && (
                <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
                  <span className="rounded-full bg-[#1C1C20]/90 px-2.5 py-1 text-[11px] font-medium text-amber-300/90 shadow-lg">
                    Stale — dev server stopped
                  </span>
                </div>
              )}
            </div>
          </div>
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
          <div
            aria-hidden={!widgetOpen}
            aria-label="Leglas tools"
            className={`w-56 rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
              // Out of the layout entirely while dragging: hidden it still
              // occupies its full box, which is what pushed the button off the
              // pointer.
              widgetDrag ? "hidden " : ""
            }${
              widgetOpen
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-1 scale-95 opacity-0"
            }`}
            inert={!widgetOpen}
            ref={popoverRef}
            role="dialog"
            tabIndex={-1}
          >
            <span className="block px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
              Typeface
            </span>
            <div
              aria-label="Interface typeface"
              className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
              role="group"
            >
              {FONTS.map((font) => (
                <button
                  aria-pressed={activeFont.key === font.key}
                  className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                    activeFont.key === font.key
                      ? "bg-[#2E2E2E] font-medium text-white"
                      : "text-[#9CA3AF] hover:text-[#D1D5DB]"
                  }`}
                  key={font.key}
                  onClick={() => st.setPrefs((prefs) => ({ ...prefs, font: font.key }))}
                  style={{ fontFamily: font.stack }}
                  type="button"
                >
                  {font.label}
                </button>
              ))}
            </div>

            <span className="block px-1 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
              Viewport
            </span>
            <div
              aria-label="Viewport width"
              className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
              role="group"
            >
              {st.viewports.map(({ label, width }) => (
                <button
                  className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                    st.prefs.viewport === width
                      ? "bg-[#2E2E2E] font-medium text-white"
                      : "text-[#9CA3AF] hover:text-[#D1D5DB]"
                  }`}
                  key={label}
                  onClick={() => st.setPrefs((prefs) => ({ ...prefs, viewport: width }))}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Only meaningful while two things are on the stage, so it appears
                when it applies rather than sitting there greyed out. */}
            {splitting && (
              <button
                aria-checked={st.prefs.scaleSplit}
                className={`${ROW_BUTTON} mt-1 ${
                  st.prefs.scaleSplit ? "text-white" : "text-[#9CA3AF]"
                }`}
                onClick={() =>
                  st.setPrefs((current) => ({ ...current, scaleSplit: !current.scaleSplit }))
                }
                role="switch"
                type="button"
              >
                <span>Scale each side to fit</span>
                <Switch on={st.prefs.scaleSplit} />
              </button>
            )}

            <span className="block px-1 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
              Dev overlays
            </span>
            <button
              aria-checked={st.prefs.showDevOverlays}
              className={`${ROW_BUTTON} ${
                st.prefs.showDevOverlays ? "text-white" : "text-[#9CA3AF]"
              }`}
              onClick={() => {
                const show = !st.prefs.showDevOverlays;
                st.setPrefs((current) => ({ ...current, showDevOverlays: show }));
                // Applied to every open pane at once, so the change is visible
                // without reloading anything.
                for (const frame of document.querySelectorAll("iframe")) {
                  applyOverlayPref(frame as HTMLIFrameElement, !show);
                }
              }}
              role="switch"
              type="button"
            >
              <span>Show dev tool overlay</span>
              <Switch on={st.prefs.showDevOverlays} />
            </button>
            <button
              aria-checked={st.prefs.showWidget}
              className={`${ROW_BUTTON} ${
                st.prefs.showWidget ? "text-white" : "text-[#9CA3AF]"
              }`}
              onClick={() => {
                const show = !st.prefs.showWidget;
                st.setPrefs((current) => ({ ...current, showWidget: show }));
                // This switch lives inside the thing it hides, so the way back
                // is named the moment the door is closed, and for longer than
                // a plain confirmation: this one is teaching a key. The rail's
                // foot keeps a line saying the same for as long as it matters.
                if (!show) {
                  st.notify({
                    kind: "widget",
                    message: "Press T to reopen the tools",
                    tone: "info",
                    ttl: TOAST_TTL.plain + 3000,
                  });
                }
              }}
              role="switch"
              type="button"
            >
              <span>Show Leglas overlay</span>
              <Switch on={st.prefs.showWidget} />
            </button>

            <button
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
              onClick={() => st.copyReference(st.active)}
              type="button"
            >
              <PIcon d={P.copy} size={12} />
              {st.copied?.kind === "reference" && st.copied.title === st.active
                ? "Copied"
                : "Copy reference"}
            </button>
            <Tip label="Or double-click any direction in the rail">
              <a
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
                href={st.urlFor(st.active)}
                rel="noreferrer"
                target="_blank"
              >
                <span className="inline-block size-3 rounded-sm border border-current" />
                Open in new tab
              </a>
            </Tip>
            <button
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
              onClick={() => {
                setWidgetOpen(false);
                setHelpOpen(true);
              }}
              type="button"
            >
              <span>Keyboard shortcuts</span>
              <kbd className="rounded border border-[#232328] bg-[#2E2E2E]/60 px-1 py-0.5 font-sans text-[10px] text-[#84848C]">
                ?
              </kbd>
            </button>
          </div>

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
                {!st.loaded[st.active] && (
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
        bottom={st.prefs.collapsed ? 12 : RAIL_FOOTER_H + 8}
        left={st.prefs.collapsed ? 60 : 12}
        onDismiss={st.dismissToast}
        toasts={st.toasts}
        width={(st.prefs.collapsed ? 320 : st.prefs.width) - 24}
      />

      {scanning !== null && (
        <iframe
          aria-hidden
          className="pointer-events-none fixed border-0"
          key={scanning}
          onLoad={(event) => onScanLoad(scanning, event.currentTarget)}
          src={st.urlFor(scanning)}
          style={{ height: 800, left: -2400, top: 0, width: 1280 }}
          tabIndex={-1}
          title="Off-stage duplicate scan"
        />
      )}

      {helpOpen ? <HelpOverlay mac={IS_MAC} onClose={closeHelp} /> : null}
    </main>
  );
}
