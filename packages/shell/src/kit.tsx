import { useEffect, useRef, useState } from "react";

import { EASE } from "./prefs.js";

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
  search:
    "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z",
  sidebar:
    "M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60H76V196H44ZM212,196H100V60H212Z",
  trash:
    "M216,48H40a12,12,0,0,0,0,24h4V208a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V72h4a12,12,0,0,0,0-24ZM188,204H68V72H188ZM76,20A12,12,0,0,1,88,8h80a12,12,0,0,1,0,24H88A12,12,0,0,1,76,20Z",
} as const;

export const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-[#D1D5DB] hover:bg-[#2E2E2E] hover:text-white";

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
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{ out: boolean; x: number; y: number } | null>(null);

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
        ? { out: false, x: rect.left + rect.width / 2, y: rect.top - 8 }
        : { out: false, x: rect.right + 8, y: rect.top + rect.height / 2 },
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
        <span aria-hidden className="pointer-events-none fixed z-[60]" style={{ left: tip.x, top: tip.y }}>
          <span
            className={`block ${side === "top" ? "-translate-x-1/2 -translate-y-full" : "-translate-y-1/2"}`}
          >
            <span
              className={`leglas-tip block whitespace-nowrap rounded-lg border border-white/10 bg-[#171717] px-2 py-1 text-xs font-medium text-white shadow-lg ${
                tip.out
                  ? side === "top"
                    ? "leglas-tip-out-top"
                    : "leglas-tip-out-right"
                  : side === "top"
                    ? "leglas-tip-in-top"
                    : "leglas-tip-in-right"
              }`}
            >
              {label}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

export function RenameForm({
  initial,
  label,
  onCancel,
  onCommit,
}: {
  initial: string;
  label: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
}) {
  const cancelled = useRef(false);
  return (
    <form
      className="px-3 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("name");
        cancelled.current = true;
        onCommit(typeof value === "string" ? value.trim() : "");
      }}
    >
      <input
        aria-label={label}
        autoFocus
        className="w-full rounded-md border border-[#232328] bg-[#2E2E2E]/40 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/60"
        defaultValue={initial}
        name="name"
        onBlur={(event) => {
          if (cancelled.current) return;
          onCommit(event.currentTarget.value.trim());
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
      <span className="leglas-shimmer-text absolute bottom-4 right-5 text-xs font-medium">
        Loading preview…
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
