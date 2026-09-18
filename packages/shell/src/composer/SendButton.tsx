/**
 * A real send button, because Enter alone is an invisible contract. Dim and
 * inert until there is something to send; the field's one moment of light
 * once there is.
 */
export function SendButton({
  ready,
  sending,
  target,
}: {
  /** There is something to send, somewhere to send it, and nothing in flight. */
  ready: boolean;
  sending: boolean;
  /** The direction the change is aimed at, as the rail names it. */
  target: string | null;
}) {
  return (
    <button
      aria-label={target === null ? "Send the change" : `Send the change to ${target}`}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none ${
        ready
          ? "bg-[#E8E8EA] text-[#1C1C20] hover:bg-white"
          : "pointer-events-none text-[#84848C]/60"
      }`}
      disabled={!ready}
      type="submit"
    >
      {sending ? (
        <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />
      ) : (
        <svg
          aria-hidden="true"
          fill="none"
          height="13"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          viewBox="0 0 16 16"
          width="13"
        >
          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
        </svg>
      )}
    </button>
  );
}
