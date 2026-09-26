import { useEffect, useState } from "react";

import { CardButton, Glyph, Icon } from "../agents/StatusCard.js";
import { formatElapsed } from "../agents/request-status.js";
import { cardFor, isRunning, runStartedAt, type GenerationJob } from "./generation.js";

function Done() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-emerald-300/90"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
      width="14"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/**
 * The set being built, in the request card's place: progress, the brief and one
 * control at a time (stop while running, dismiss once over). Each direction's
 * state is on its row.
 */
export function GenerationCard({
  compare,
  comparing,
  job,
  onDismiss,
  onStop,
  stopping,
}: {
  /** How many would be shown whole, and the switch between that and one; null while fewer than two can be. */
  compare: { count: number; toggle: () => void } | null;
  /** The set is on the stage whole. */
  comparing: boolean;
  job: GenerationJob;
  onDismiss: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const card = cardFor(job);
  const running = isRunning(job);
  // The clock ticks here so one second passing redraws this card and not the rail.
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [running]);

  return (
    <div
      className="mx-3 mt-2 rounded-lg border border-[#232328] bg-[#1E1E22] px-2.5 py-2 shadow-lg"
      role="status"
    >
      <div className="flex items-center gap-2">
        {card.tone === "done" ? (
          <Done />
        ) : (
          <Glyph kind={card.tone === "working" ? "running" : card.tone} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium leading-tight text-[#D1D5DB]">
            {card.text}
          </p>
          {/* Variations may be asked for with nothing typed; their title says enough. */}
          {job.brief !== "" && (
            <p className="mt-0.5 truncate text-[10px] leading-tight text-[#84848C]">
              “{job.brief}”
            </p>
          )}
        </div>
        {running && (
          <span className="shrink-0 text-[10px] tabular-nums text-[#84848C]">
            {formatElapsed(clock - runStartedAt(job))}
          </span>
        )}
        {compare !== null && (
          <button
            aria-pressed={comparing}
            className="h-6 shrink-0 rounded-md bg-white/[0.06] px-2 text-[10px] font-medium text-[#D1D5DB] transition-[background-color,color,transform] duration-150 hover:bg-white/[0.1] hover:text-white active:scale-[0.96] motion-reduce:transition-none"
            onClick={compare.toggle}
            type="button"
          >
            {comparing ? "Show one" : `Compare all ${compare.count}`}
          </button>
        )}
        {running ? (
          <CardButton
            busy={stopping}
            disabled={stopping}
            label="Stop building these directions"
            onClick={onStop}
            standalone
            tip="Stop them all"
          >
            <span className="block size-2 rounded-[2px] bg-current" />
          </CardButton>
        ) : (
          <CardButton
            busy={false}
            disabled={false}
            label="Dismiss this set's summary"
            onClick={onDismiss}
            standalone
            tip="Let it go"
          >
            <Icon>
              <path d="m4 4 8 8M12 4l-8 8" />
            </Icon>
          </CardButton>
        )}
      </div>
    </div>
  );
}
