import { Tip } from "../ui/kit.js";

/**
 * The way into annotating that is not a keystroke, and the count that says
 * the pins are still there once the mode is left.
 */
export function AnnotateButton({
  annotating,
  count,
  onToggle,
}: {
  annotating: boolean;
  /** Notes on the active direction that have not been sent yet. */
  count: number;
  onToggle: () => void;
}) {
  return (
    <Tip
      label={
        <>
          <span className="block">
            {annotating
              ? "Stop annotating"
              : count > 0
                ? "Show what you marked up"
                : "Point at what is wrong, instead of describing where it is"}
          </span>
          <span className="block text-[#9CA3AF]">
            {annotating ? (
              "Click a detail · drag an area · Esc to stop"
            ) : (
              <kbd className="font-sans">A</kbd>
            )}
          </span>
        </>
      }
    >
      <button
        aria-keyshortcuts="a"
        aria-label={
          annotating
            ? "Stop annotating the design"
            : `Annotate the design${
                count > 0 ? `, ${count} annotation${count === 1 ? "" : "s"} so far` : ""
              }`
        }
        aria-pressed={annotating}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium leading-none transition-colors ${
          annotating
            ? "bg-[#7C9CFF]/20 text-[#AFC2FF]"
            : "text-[#84848C] hover:bg-white/[0.06] hover:text-[#D1D5DB]"
        }`}
        onClick={onToggle}
        type="button"
      >
        <svg
          aria-hidden
          fill="none"
          height="11"
          stroke="currentColor"
          strokeWidth="1.7"
          viewBox="0 0 16 16"
          width="11"
        >
          <path
            d="M8 1.8a4.2 4.2 0 0 1 4.2 4.2c0 3-4.2 8-4.2 8S3.8 9 3.8 6A4.2 4.2 0 0 1 8 1.8Z"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="6" r="1.4" />
        </svg>
        Annotate
        {count > 0 ? (
          <span className="rounded-full bg-white/15 px-1 text-[9px] leading-[1.5] text-white">
            {count}
          </span>
        ) : null}
      </button>
    </Tip>
  );
}
