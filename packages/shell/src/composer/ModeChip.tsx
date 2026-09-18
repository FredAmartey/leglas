import { Tip } from "../ui/kit.js";

/**
 * What the change does to the direction it is aimed at, in the one place the
 * aiming happens. A chip rather than a setting: it is a per-change decision,
 * and the answer has to be readable in the second before Enter.
 */
export function ModeChip({
  mode,
  onToggle,
}: {
  mode: "variant" | "replace";
  onToggle: () => void;
}) {
  return (
    <Tip
      label={
        mode === "variant"
          ? "Builds a new direction beside this one and leaves this one alone."
          : "Changes this direction itself. Nothing is kept of what it was."
      }
    >
      <button
        aria-label={
          mode === "variant"
            ? "This change makes a new variant. Switch to changing the direction itself."
            : "This change edits the direction itself. Switch to making a new variant."
        }
        className="mr-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium leading-none text-[#84848C] transition-colors hover:bg-white/[0.06] hover:text-[#D1D5DB]"
        onClick={onToggle}
        type="button"
      >
        {mode === "variant" ? (
          <svg
            aria-hidden
            fill="none"
            height="11"
            stroke="currentColor"
            strokeWidth="1.7"
            viewBox="0 0 16 16"
            width="11"
          >
            <circle cx="4.5" cy="3.6" r="1.9" />
            <circle cx="11.5" cy="12.4" r="1.9" />
            <path d="M4.5 5.5v2.6a4.3 4.3 0 0 0 4.3 4.3h0.8" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            aria-hidden
            fill="none"
            height="11"
            stroke="currentColor"
            strokeWidth="1.7"
            viewBox="0 0 16 16"
            width="11"
          >
            <path d="M10.8 2.9 13.1 5.2 5.6 12.7H3.3v-2.3z" strokeLinejoin="round" />
          </svg>
        )}
        {mode === "variant" ? "as a variant" : "in place"}
      </button>
    </Tip>
  );
}
