import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import { MOOD } from "./orb.js";
import { EASE } from "./prefs.js";
import { placeTip, type Placement } from "./tip.js";
import type { Toast } from "./toasts.js";

/**
 * Two offset rounded squares: layers of the same app. Monochrome, because the
 * chrome carries no hue and so can never bias a preview.
 */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <rect
        height="13"
        rx="3"
        stroke="rgba(244,244,245,0.36)"
        strokeWidth="2"
        width="13"
        x="8"
        y="3"
      />
      <rect
        fill="#1C1C20"
        height="13"
        rx="3"
        stroke="#F4F4F5"
        strokeWidth="2"
        width="13"
        x="3"
        y="8"
      />
    </svg>
  );
}

/** Phosphor paths, 256 viewBox. */
export const P = {
  copy: "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z",
  pencil:
    "M230.14,70.54,185.46,25.85a20,20,0,0,0-28.29,0L33.86,149.17A19.85,19.85,0,0,0,28,163.31V208a20,20,0,0,0,20,20H92.69a19.86,19.86,0,0,0,14.14-5.86L230.14,98.82a20,20,0,0,0,0-28.28ZM91,204H52V165l84-84,39,39ZM192,103,153,64l18.34-18.34,39,39Z",
  // link-simple rather than link: the diagonal chain silts up at 13px, where
  // this one still reads as two links meeting.
  link: "M87.5,151.52l64-64a12,12,0,0,1,17,17l-64,64a12,12,0,0,1-17-17Zm131-114a60.08,60.08,0,0,0-84.87,0L103.51,67.61a12,12,0,0,0,17,17l30.07-30.06a36,36,0,0,1,50.93,50.92L171.4,135.52a12,12,0,1,0,17,17l30.08-30.06A60.09,60.09,0,0,0,218.45,37.55ZM135.52,171.4l-30.07,30.08a36,36,0,0,1-50.92-50.93l30.06-30.07a12,12,0,0,0-17-17L37.55,133.58a60,60,0,0,0,84.88,84.87l30.06-30.07a12,12,0,0,0-17-17Z",
  search:
    "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z",
  split:
    "M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60h72V196H44ZM212,196H140V60h72Z",
  sidebar:
    "M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60H76V196H44ZM212,196H100V60H212Z",
  trash:
    "M216,48H40a12,12,0,0,0,0,24h4V208a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V72h4a12,12,0,0,0,0-24ZM188,204H68V72H188ZM76,20A12,12,0,0,1,88,8h80a12,12,0,0,1,0,24H88A12,12,0,0,1,76,20Z",
} as const;

export const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-[#D1D5DB] hover:bg-[#2E2E2E] hover:text-white";

/**
 * The track a settings row flips. Presentation only: the row button carries
 * the switch role and the checked state, this just draws it.
 *
 * The off track is darker than the row's hover surface, not the same #2E2E2E,
 * so it stays visible under the pointer.
 */
export function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none ${
        on ? "bg-[#E6E8EC]" : "bg-[#17181B]"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 size-2.5 rounded-full transition-transform duration-150 motion-reduce:transition-none ${
          on ? "translate-x-2.5 bg-[#17181B]" : "bg-[#84848C]"
        }`}
      />
    </span>
  );
}

export function PIcon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden fill="currentColor" height={size} viewBox="0 0 256 256" width={size}>
      <path d={d} />
    </svg>
  );
}

/**
 * A dark bubble 8px off the control, with a 300ms first-hover delay and a
 * 300ms warm window so neighbouring controls answer instantly. Enters on a
 * slightly overshooting rise; closes on activation.
 */
let tipWarmUntil = 0;

export function Tip({
  children,
  label,
  side = "top",
}: {
  children: React.ReactNode;
  label: React.ReactNode;
  side?: "right" | "top";
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{
    at: Placement;
    out: boolean;
    shift: number;
    x: number;
    y: number;
  } | null>(null);

  /**
   * Nudge the label back on screen once it has been measured.
   *
   * Placing from the anchor alone puts it off the top in a top corner and past
   * the right edge in the bottom right, which is where the floating widget
   * lives. Corrections run before paint, so nothing is seen out of place, and
   * they converge: a pass that changes nothing returns null.
   *
   * The label is a dependency because it can change while the tip is open:
   * clicking the fold chevron swaps "Show 2 variants" for the wider "Fold the
   * variants away" without closing it, and a fit measured for the short label
   * left the long one clipped by the rail edge.
   */
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const control = anchorRef.current?.firstElementChild;
    if (!tip || tip.out || !bubble || !control) return;
    // Layout size, not the painted rect: the label enters at scale(0.8), so
    // measuring the rect mid-animation reads it narrower than it lands and
    // under-corrects. Transforms do not touch offsetWidth.
    const corrected = placeTip(
      tip,
      { height: bubble.offsetHeight, width: bubble.offsetWidth },
      control.getBoundingClientRect(),
      { height: window.innerHeight, width: window.innerWidth },
    );
    if (corrected) {
      setTip((current) => (current ? { ...current, ...corrected } : current));
    }
  }, [label, tip?.at, tip?.out, tip?.shift, tip?.x, tip?.y]);

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const open = () => {
    const control = anchorRef.current?.firstElementChild;
    if (!control) return;
    const rect = control.getBoundingClientRect();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setTip(
      side === "top"
        ? { at: "top", out: false, shift: 0, x: rect.left + rect.width / 2, y: rect.top - 8 }
        : { at: "right", out: false, shift: 0, x: rect.right + 8, y: rect.top + rect.height / 2 },
    );
  };
  const enter = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(open, Date.now() < tipWarmUntil ? 0 : 300);
  };
  const close = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    tipWarmUntil = Date.now() + 300;
    setTip((current) => (current && !current.out ? { ...current, out: true } : current));
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTip(null), 120);
  };

  return (
    <span
      className="contents"
      onBlur={close}
      onFocus={(event) => {
        if ((event.target as HTMLElement).matches(":focus-visible")) open();
      }}
      onPointerDown={close}
      onPointerEnter={enter}
      onPointerLeave={close}
      ref={anchorRef}
    >
      {children}
      {tip && (
        <span
          aria-hidden
          className="pointer-events-none fixed z-[60]"
          style={{ left: tip.x + tip.shift, top: tip.y }}
        >
          <span
            className={`block ${
              {
                bottom: "-translate-x-1/2",
                right: "-translate-y-1/2",
                top: "-translate-x-1/2 -translate-y-full",
              }[tip.at]
            }`}
          >
            <span
              className={`leglas-tip block whitespace-nowrap rounded-lg border border-white/10 bg-[#171717] px-2 py-1 text-xs font-medium text-white shadow-lg ${
                tip.out ? `leglas-tip-out-${tip.at}` : `leglas-tip-in-${tip.at}`
              }`}
              ref={bubbleRef}
            >
              {label}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The name, made editable where it sits.
 *
 * It carries the title's own type and line height and draws its edge with a
 * ring rather than a border, because a ring takes no space: the row keeps its
 * exact height, and nothing below it moves while a name is being changed. The
 * caller owns the surrounding layout and shows the error in its own slot.
 *
 * Submitting and clicking away both commit, and they are told apart because
 * they deserve different treatment when the name is refused: a name typed and
 * entered should be correctable where it stands, while someone who has already
 * moved on should not be dragged back into a field they left.
 */
export function RenameForm({
  error,
  initial,
  label,
  onCancel,
  onCommit,
}: {
  error?: string | null;
  initial: string;
  label: string;
  onCancel: () => void;
  onCommit: (value: string, via: "blur" | "submit") => void;
}) {
  const cancelled = useRef(false);
  // A refused submit leaves the form standing, so the guard the submit raised
  // has to come back down or the corrected name would never commit on blur.
  useEffect(() => {
    if (error) cancelled.current = false;
  });

  return (
    <form
      className="leglas-rename min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("name");
        cancelled.current = true;
        onCommit(typeof value === "string" ? value.trim() : "", "submit");
      }}
    >
      <input
        aria-describedby={error ? "leglas-rename-error" : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={label}
        autoFocus
        className={`-mx-1 block w-[calc(100%+0.5rem)] rounded-[4px] bg-transparent px-1 py-0 text-sm font-medium leading-5 text-white outline-none ring-1 ${
          error ? "ring-amber-400/60" : "ring-[#D1D5DB]/45 focus:ring-[#D1D5DB]/70"
        }`}
        defaultValue={initial}
        name="name"
        onBlur={(event) => {
          if (cancelled.current) return;
          onCommit(event.currentTarget.value.trim(), "blur");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            cancelled.current = true;
            onCancel();
          }
        }}
        type="text"
      />
    </form>
  );
}

const TOAST_DOT = {
  danger: "bg-amber-300",
  info: "bg-[#9CA3AF]",
  success: "bg-emerald-300",
} as const;

/** How long the leaving animation runs; the toast holds its slot until then. */
const TOAST_OUT_MS = 140;

function ToastItem({ onDismiss, toast }: { onDismiss: () => void; toast: Toast }) {
  const [out, setOut] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** What is left of the toast's time, so a pause resumes instead of restarting. */
  const remaining = useRef(toast.ttl);
  const outTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const leave = () => {
    if (outTimer.current) return;
    setOut(true);
    outTimer.current = setTimeout(onDismiss, TOAST_OUT_MS);
  };

  // A toast holding an undo must not expire out from under the cursor reaching
  // for it, so hovering or focusing it stops the clock where it stands.
  const paused = hovered || focused;
  useEffect(() => {
    if (out || paused || remaining.current === null) return;
    const startedAt = Date.now();
    const timer = setTimeout(leave, remaining.current);
    return () => {
      clearTimeout(timer);
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out, paused]);

  useEffect(
    () => () => {
      if (outTimer.current) clearTimeout(outTimer.current);
    },
    [],
  );

  // The surface is lighter than the rail it sits in, so a toast reads as
  // something that arrived rather than another panel that was always there.
  return (
    <li
      className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border border-white/10 bg-[#2E2E2E] px-3 py-2.5 shadow-xl shadow-black/40 ${
        out ? "leglas-toast-out" : "leglas-toast-in"
      }`}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${TOAST_DOT[toast.tone]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-snug text-[#E8E8EA]">{toast.message}</span>
        {toast.detail ? (
          <span
            className="mt-1 block cursor-text select-text break-all text-[10px] leading-snug text-[#9CA3AF]"
            data-selectable=""
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {toast.detail}
          </span>
        ) : null}
      </span>
      {toast.action ? (
        <button
          className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
          onClick={() => {
            toast.action?.run();
            leave();
          }}
          type="button"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        aria-label="Dismiss"
        className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-[#84848C] transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
        onClick={leave}
        type="button"
      >
        <svg className="size-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 10 10">
          <path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

/**
 * Outcomes, stacked at the foot of the rail rather than over the stage.
 *
 * Everything else in this chrome stays off the design being judged, and a
 * toast is no different: it belongs with the rows whose actions raised it.
 * Newest sits at the bottom, nearest where the eye already is. With the rail
 * collapsed there is no rail to sit in, so the stack steps just clear of it.
 */
export function Toasts({
  bottom,
  left,
  onDismiss,
  toasts,
  width,
}: {
  bottom: number;
  left: number;
  onDismiss: (id: number) => void;
  toasts: readonly Toast[];
  width: number;
}) {
  return (
    <ol
      aria-live="polite"
      className={`pointer-events-none fixed z-40 flex flex-col gap-2 transition-[bottom,left,width] duration-200 ${EASE} motion-reduce:transition-none`}
      style={{ bottom, left, width }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={() => onDismiss(toast.id)} toast={toast} />
      ))}
    </ol>
  );
}

/** Shaped like the page it resolves into, so the wait reads as loading rather than breakage. */
export function SkeletonOverlay({ loaded }: { loaded: boolean }) {
  return (
    <div
      aria-hidden
      className={`absolute inset-0 overflow-hidden bg-white transition-opacity duration-700 ${EASE} ${
        loaded ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div>
        <div className="mx-auto mt-6 h-12 w-[400px] max-w-[80%] rounded-full bg-neutral-200/80" />
        <div className="mx-auto mt-24 grid w-full max-w-5xl grid-cols-[1.05fr_0.95fr] items-start gap-16 px-12 max-[900px]:grid-cols-1">
          <div>
            <div className="h-14 w-4/5 rounded-lg bg-neutral-200" />
            <div className="mt-3 h-14 w-3/5 rounded-lg bg-neutral-200" />
            <div className="mt-8 h-4 w-full max-w-[420px] rounded bg-neutral-200/80" />
            <div className="mt-2 h-4 w-4/5 max-w-[360px] rounded bg-neutral-200/80" />
            <div className="mt-10 h-12 w-44 rounded-full bg-neutral-200" />
          </div>
          <div className="h-[420px] w-60 justify-self-center rounded-[2.5rem] bg-neutral-200 max-[900px]:hidden" />
        </div>
      </div>
      {/* One diagonal band sweeps the skeleton, a shimmer in place of a pulse. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
        <div
          className="absolute inset-0 -translate-x-full animate-[leglas-skeleton-sweep_1.6s_ease-in-out_infinite]"
          style={{
            background:
              "linear-gradient(100deg, transparent 32%, rgba(255,255,255,0.55) 50%, transparent 68%)",
          }}
        />
      </div>
      <span className="absolute bottom-4 right-5 flex items-center gap-2">
        <ThinkingOrb aria-label="" size={20} state={MOOD} theme="light" />
        <span className="leglas-shimmer-text text-xs font-medium">Loading preview…</span>
      </span>
    </div>
  );
}

/** Shown when a preview never loads: a quiet title, the reason, one affordance. */
export function ErrorOverlay({ onReload, reason }: { onReload: () => void; reason: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center"
      role="alert"
    >
      <div className="max-w-xs">
        <p className="text-sm font-medium text-neutral-800">Preview didn’t load</p>
        <p className="mt-1 text-xs leading-snug text-neutral-500">{reason}</p>
      </div>
      <button
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700"
        onClick={onReload}
        type="button"
      >
        Reload
      </button>
    </div>
  );
}
