import { Tip } from "../ui/kit.js";
import { describeBytes, type ReferenceDraft } from "./references.js";

/**
 * The images riding with the next change, inside the composer's border since
 * they're part of the same request. Each is drawn at its own aspect at a fixed
 * height, so a phone screenshot and a wide hero look like what they are.
 *
 * Three states visible at rest: landing (corner spinner), landed (nothing
 * extra), refused (amber edge, and the whole tile retries). Remove shows on
 * hover or focus.
 */
export function ReferenceStrip({
  drafts,
  onRemove,
  onRetry,
}: {
  drafts: readonly ReferenceDraft[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (drafts.length === 0) return null;

  return (
    <ul aria-label="Images attached to this change" className="flex flex-wrap gap-1.5 px-2 pt-2">
      {drafts.map((draft) => {
        const failed = draft.status === "failed";

        return (
          <li className="leglas-reference group/reference relative" key={draft.key}>
            <Tip
              label={
                failed ? (
                  <>
                    <span className="block">Did not upload</span>
                    <span className="block text-[#9CA3AF]">Click to try again</span>
                  </>
                ) : (
                  `${draft.name} · ${describeBytes(draft.bytes)}`
                )
              }
            >
              {failed ? (
                <button
                  aria-label={`${draft.name} did not upload. Try again`}
                  className="block rounded transition-transform duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.96] motion-reduce:transition-none"
                  onClick={() => onRetry(draft.key)}
                  type="button"
                >
                  <Thumb draft={draft} failed />
                </button>
              ) : (
                <Thumb draft={draft} failed={false} />
              )}
            </Tip>
            {/* One corner slot: a spinner while landing, an amber mark if
                refused, nothing once landed. The amber edge alone looked
                like a selection ring at this size. */}
            {draft.status === "uploading" ? (
              <span
                aria-label="Uploading"
                className="absolute bottom-1 right-1 size-3 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white motion-reduce:animate-none"
                role="status"
              />
            ) : failed ? (
              <span
                aria-hidden="true"
                className="absolute bottom-1 right-1 flex size-3 items-center justify-center rounded-full bg-amber-400 text-[9px] font-semibold leading-none text-[#1C1C20]"
              >
                !
              </span>
            ) : null}
            <button
              aria-label={`Remove ${draft.name}`}
              className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-[#1E1E22] text-[#D1D5DB] opacity-0 shadow-[0_0_0_1px_rgba(255,255,255,0.12)] transition-[opacity,color,transform] duration-150 hover:text-white focus-visible:opacity-100 active:scale-[0.96] group-hover/reference:opacity-100 motion-reduce:transition-none"
              onClick={() => onRemove(draft.key)}
              type="button"
            >
              <svg
                aria-hidden
                fill="none"
                height="8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.75"
                viewBox="0 0 16 16"
                width="8"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Outlined in faint white so it holds an edge on the dark field; a tall image
 * gets a minimum width so a phone screenshot isn't a sliver.
 */
function Thumb({ draft, failed }: { draft: ReferenceDraft; failed: boolean }) {
  return (
    <img
      alt={draft.name}
      className={`block h-10 w-auto min-w-10 max-w-28 rounded object-cover ${
        failed
          ? "opacity-70 shadow-[0_0_0_1px_rgba(251,191,36,0.8)]"
          : "shadow-[0_0_0_1px_rgba(255,255,255,0.1)]"
      }`}
      draggable={false}
      src={draft.url}
    />
  );
}
