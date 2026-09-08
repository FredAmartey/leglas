import { useEffect, useRef, useState } from "react";

import { PRIMARY_BUTTON, Spinner, Warning } from "./kit.js";
import { updateView } from "./update.js";
import { useDismissal } from "./useDismissal.js";
import type { UpdateHandle } from "./useUpdate.js";

const QUIET_BUTTON =
  "flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-xs text-[#9CA3AF] transition-colors duration-150 hover:bg-white/[0.06] hover:text-[#D1D5DB] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** Skip on its own, when there is nothing to update with: it takes the row rather than floating in it. */
const LONE_BUTTON =
  "flex h-7 flex-1 items-center justify-center rounded-md border border-[#2E2E33] px-3 text-xs text-[#D1D5DB] transition-colors duration-150 hover:bg-white/[0.04] hover:text-white motion-reduce:transition-none";

/**
 * The version chip's panel: which Leglas this is, whether a newer one
 * exists and the one button that brings it in.
 *
 * Everything it says is worked out in `updateView`, so this only lays the
 * words out. The shape follows the share panel beside it: a dialog hung
 * under the rail's header, dismissed by Escape, a click elsewhere or the
 * window losing focus, with focus handed back to the chip.
 */
export function UpdatePanel({
  onClose,
  open,
  triggerRef,
  updates,
}: {
  onClose: () => void;
  open: boolean;
  /** The chip that opened this, for focus to return to. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  updates: UpdateHandle;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useDismissal(open, panelRef, triggerRef, onClose);

  /**
   * A clock the panel reads, so "checked 2 minutes ago" moves while it is
   * open. A minute is fine: nothing here is measured in seconds.
   */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const view = updateView(updates.status, updates.wait, updates.checking, clock);
  const act = () => {
    if (view.primary === null) return;
    if (view.primary.action === "check") updates.check();
    else updates.install();
  };

  return (
    <div
      aria-hidden={!open}
      aria-label="Updates"
      className={`absolute inset-x-3 top-full z-30 mt-1.5 origin-top-left rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 text-[#D1D5DB] shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
        open ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none -translate-y-1 scale-95 opacity-0"
      }`}
      inert={!open}
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="flex items-center justify-between px-1 pb-1.5 pt-0.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[#84848C]">Leglas</span>
        {view.link !== null && (
          <a
            className="text-[10px] text-[#84848C] transition-colors hover:text-[#D1D5DB]"
            href={view.link.url}
            rel="noreferrer"
            target="_blank"
          >
            {view.link.label}
          </a>
        )}
      </div>

      <div className="px-1">
        <p className="text-xs leading-snug text-white">{view.heading}</p>
        {view.title !== null && (
          <p className="mt-0.5 text-[11px] leading-snug text-[#D1D5DB]">{view.title}</p>
        )}
        {view.detail !== null && (
          <p
            aria-live="polite"
            className={`mt-1 flex items-start gap-1.5 text-[10px] leading-snug ${
              view.warning ? "text-amber-300/90" : "text-[#9CA3AF]"
            }`}
          >
            {view.spinner && (
              <span className="mt-px">
                <Spinner />
              </span>
            )}
            {view.warning && (
              <span className="mt-px">
                <Warning />
              </span>
            )}
            <span>{view.detail}</span>
          </p>
        )}
        {view.meta !== null && (
          <p className="mt-0.5 text-[10px] leading-snug text-[#84848C]">{view.meta}</p>
        )}
      </div>

      {(view.primary !== null || view.skip) && (
        <div className="mt-2.5 flex items-center gap-1 px-1">
          {view.primary !== null && (
            <button
              className={PRIMARY_BUTTON}
              disabled={view.primary.disabled}
              onClick={act}
              type="button"
            >
              {view.primary.label}
            </button>
          )}
          {view.skip && (
            <button
              className={view.primary === null ? LONE_BUTTON : QUIET_BUTTON}
              onClick={updates.skip}
              type="button"
            >
              {view.primary === null ? "Skip this version" : "Skip"}
            </button>
          )}
        </div>
      )}

      {view.note !== null && (
        <p className="px-1 pb-0.5 pt-2 text-[10px] leading-snug text-[#84848C]">{view.note}</p>
      )}
    </div>
  );
}
