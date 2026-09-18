import { REFERENCE_TYPES } from "../references/references.js";
import { Tip } from "../ui/kit.js";

/**
 * Showing beats describing: a screenshot of the thing the words are about, or
 * of the thing they should become. Paste and drop do the same job; this is
 * the way in for anyone who does neither.
 */
export function AttachButton({
  count,
  disabled,
  inputRef,
  onFiles,
}: {
  /** How many images ride with the next change already. */
  count: number;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  return (
    <>
      <input
        accept={REFERENCE_TYPES.join(",")}
        className="sr-only"
        multiple
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []));
          // Cleared so the same file can be chosen again after a
          // remove; a file input only fires when its value changes.
          event.currentTarget.value = "";
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      <Tip
        label={
          <>
            <span className="block">Attach a reference image</span>
            <span className="block text-[#9CA3AF]">Paste or drop one, too</span>
          </>
        }
      >
        <button
          aria-label={
            count > 0 ? `Attach another image, ${count} attached` : "Attach a reference image"
          }
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#84848C] transition-[background-color,color,transform] duration-150 hover:bg-white/[0.06] hover:text-[#D1D5DB] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <svg
            aria-hidden
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 16 16"
            width="11"
          >
            <rect height="10.5" rx="1.8" width="12.5" x="1.75" y="2.75" />
            <circle cx="5.6" cy="6.3" r="1.1" />
            <path d="m14.25 10.4-3.1-3.1a1 1 0 0 0-1.4 0L4.5 12.5" />
          </svg>
        </button>
      </Tip>
    </>
  );
}
