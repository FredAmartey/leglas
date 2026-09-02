import { Fragment, useEffect, useRef, useState } from "react";

import { Tip } from "./kit.js";
import { collapseChain } from "./lineage.js";

/** How long the ask takes to open or close. */
const ASK_MS = 200;

/**
 * Where the selected direction came from, as a path under the composer.
 *
 * The one-line form said "Variant of Altar", which is the parent and nothing
 * more. For a direction five passes deep the parent is the least of it: the
 * root says which family this is and the passes between say how it got here.
 * Each crumb is the way to that direction, and holding shift makes it the
 * comparison instead, so "how far is this from three passes ago" is one click
 * rather than a search through the rail.
 *
 * A long chain keeps its two ends and folds the middle behind one gesture:
 * the rail is narrow, and the root and the parent are the two names the
 * question is usually about.
 *
 * On a rail that draws the lineage, the crumbs and the gutter are the same
 * fact twice, so they answer together: resting on a crumb lights that
 * direction's line in the gutter and its row in the rail. The ask stays one
 * line until it is wanted, then opens where it is; it is the words that
 * decide the next thing typed, and a native tooltip is a slow way to read them.
 */
export function Crumbs({
  askedFor,
  chain,
  displayName,
  onCompare,
  onGo,
  onRail,
  onTrace,
  openAsk = false,
  self,
  tint,
  traced = null,
}: {
  askedFor: string | null;
  /** Root first, the selected direction excluded. */
  chain: readonly string[];
  displayName: (title: string) => string;
  onCompare: (title: string) => void;
  onGo: (title: string) => void;
  /** Whether a crumb can be gone to: a removed ancestor is named, not linked. */
  onRail: (title: string) => boolean;
  /** The pointer is resting on a crumb, or has left them. */
  onTrace?: ((title: string | null) => void) | undefined;
  /** Let the ask open in place instead of truncating for good. */
  openAsk?: boolean;
  self: string;
  /** The light's colour; the crumb for the direction on stage wears a dot of it. */
  tint?: string | undefined;
  /** The direction whose line is being traced, to name it here as well. */
  traced?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  /**
   * The clamp waits for the box. Clamping the moment the ask closes would
   * show one line with an ellipsis above a box still shrinking around
   * nothing, so the text stays whole until the collapse has landed.
   */
  const [askSettled, setAskSettled] = useState(true);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );
  const toggleAsk = () => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setAskSettled(still);
    setAskOpen((current) => !current);
    // A timer rather than transitionend: the event never comes when there
    // was nothing to transition, and the clamp has to come back regardless.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setAskSettled(true), still ? 0 : ASK_MS + 20);
  };
  const parts = expanded ? { head: [...chain], hidden: [], tail: [] } : collapseChain(chain);
  const separator = (
    <span aria-hidden className="select-none text-[#84848C]/50">
      ›
    </span>
  );

  const crumb = (title: string) => {
    const name = displayName(title);
    if (!onRail(title)) {
      return (
        <span className="max-w-36 truncate text-[#84848C]/70" title={`${name} is not on the rail`}>
          {name}
        </span>
      );
    }
    return (
      <Tip
        label={
          <>
            <span className="block">Go to {name}</span>
            <span className="block text-[#9CA3AF]">Shift-click to compare</span>
          </>
        }
      >
        <button
          className={`max-w-36 truncate rounded text-left transition-colors duration-150 hover:text-[#E8E8EA] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60 ${
            traced === title ? "text-[#E8E8EA]" : ""
          }`}
          onClick={(event) => (event.shiftKey ? onCompare(title) : onGo(title))}
          onPointerEnter={() => onTrace?.(title)}
          onPointerLeave={() => onTrace?.(null)}
          type="button"
        >
          {name}
        </button>
      </Tip>
    );
  };

  const ask = askedFor === null ? null : `You asked for “${askedFor}”`;

  return (
    <div className="px-3 pb-2">
      <nav
        aria-label={`Where ${displayName(self)} came from`}
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] leading-snug text-[#84848C]"
      >
        {parts.head.map((title) => (
          <Fragment key={title}>
            {crumb(title)}
            {separator}
          </Fragment>
        ))}
        {parts.hidden.length > 0 && (
          <>
            <Tip
              label={
                <>
                  {parts.hidden.map((title) => (
                    <span className="block" key={title}>
                      {displayName(title)}
                    </span>
                  ))}
                </>
              }
              wide
            >
              <button
                aria-label={`Show the ${parts.hidden.length} directions between`}
                className="rounded px-0.5 tracking-widest transition-colors hover:text-[#D1D5DB] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
                onClick={() => setExpanded(true)}
                type="button"
              >
                …
              </button>
            </Tip>
            {separator}
          </>
        )}
        {parts.tail.map((title) => (
          <Fragment key={title}>
            {crumb(title)}
            {separator}
          </Fragment>
        ))}
        <span
          className={`inline-flex max-w-36 items-center gap-1 truncate transition-colors duration-150 ${
            traced === self ? "text-[#E8E8EA]" : "text-[#D1D5DB]"
          }`}
        >
          {tint !== undefined && (
            <span aria-hidden className="inline-block size-[5px] shrink-0 rounded-full" style={{ background: tint }} />
          )}
          {displayName(self)}
        </span>
      </nav>
      {ask === null ? null : openAsk ? (
        // The whole line is the control and it opens downward in place: a
        // few more lines of the rail's own words, then back to one. The
        // clamp swaps at the same moment the box grows, so the ellipsis is
        // never seen on a line that has room.
        <button
          aria-expanded={askOpen}
          aria-label={askOpen ? "Show less of the request" : "Show the whole request"}
          className="mt-0.5 block w-full cursor-pointer overflow-hidden text-left text-[10px] leading-snug text-[#84848C] transition-[max-height,color] ease-out hover:text-[#A1A1AA] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60 motion-reduce:transition-none"
          onClick={toggleAsk}
          style={{ maxHeight: askOpen ? 96 : 14, transitionDuration: `${ASK_MS}ms` }}
          type="button"
        >
          <span className={!askOpen && askSettled ? "line-clamp-1" : "block"}>{ask}</span>
        </button>
      ) : (
        <p className="mt-0.5 min-w-0 truncate text-[10px] leading-snug text-[#84848C]" title={askedFor ?? ""}>
          {ask}
        </p>
      )}
    </div>
  );
}
