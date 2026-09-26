import { buildLabel, MAX_DIRECTIONS } from "./generation.js";

const STEP =
  "flex size-6 items-center justify-center rounded text-[#9CA3AF] transition-[background-color,color,transform] duration-150 hover:bg-white/[0.06] hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30 motion-reduce:transition-none";

/**
 * The composer's controls while taking a brief: how many directions, and a
 * button saying what it'll make and whose plan pays. A stepper, not a menu,
 * since the range is small and the number should show.
 */
export function BriefToolbar({
  agent,
  count,
  onCount,
  picker,
  reason,
  ready,
  starting,
}: {
  /** Who builds it, by name. */
  agent: string;
  count: number;
  onCount: (count: number) => void;
  /** The agent picker, beside a reason that asks for a different agent. */
  picker: React.ReactNode;
  /** Why it cannot build right now, said in place of the button's promise. */
  reason: string | null;
  ready: boolean;
  starting: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-1.5 p-1">
      <div aria-label="How many directions" className="flex items-center" role="group">
        <button
          aria-label="One direction fewer"
          className={STEP}
          disabled={count <= 1 || starting}
          onClick={() => onCount(count - 1)}
          type="button"
        >
          <svg aria-hidden="true" height="12" viewBox="0 0 16 16" width="12">
            <path d="M3.5 8h9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
          </svg>
        </button>
        <span
          aria-live="polite"
          className="w-5 text-center text-[11px] font-medium tabular-nums text-[#D1D5DB]"
        >
          {count}
        </span>
        <button
          aria-label="One direction more"
          className={STEP}
          disabled={count >= MAX_DIRECTIONS || starting}
          onClick={() => onCount(count + 1)}
          type="button"
        >
          <svg aria-hidden="true" height="12" viewBox="0 0 16 16" width="12">
            <path
              d="M3.5 8h9M8 3.5v9"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.75"
            />
          </svg>
        </button>
      </div>
      {reason === null ? (
        <button
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-[#E8E8EA] px-2.5 text-[11px] font-medium text-[#1C1C20] transition-[background-color,transform,opacity] duration-150 hover:bg-white active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          disabled={!ready || starting}
          type="submit"
        >
          {starting && (
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
            />
          )}
          {buildLabel(count, agent)}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate text-right text-[10px] leading-snug text-[#84848C]">
            {reason}
          </p>
          {picker}
        </span>
      )}
    </div>
  );
}
