import { ThinkingOrb } from "thinking-orbs";

import { Gutter } from "../lineage/Gutter.js";
import type { Segment } from "../lineage/lineage.js";
import { EASE } from "../prefs.js";
import { ICON_BUTTON, P, PIcon, RenameForm, Tip } from "../ui/kit.js";
import { MOOD } from "../ui/orb.js";
import type { ShellState } from "../useShellState.js";
import type { Drag, DragMeta } from "./drag.js";
import { RowCard } from "./RowCard.js";
import { tagTone } from "./tags.js";

/** A title as a CSS identifier, for a row's view-transition-name. */
function rowIdent(title: string): string {
  let hash = 0;

  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return Math.abs(hash).toString(36);
}

/**
 * What is happening to a direction, in the corner of its row. One thing at a
 * time, the most pressing first: being carried by a drag, being compared,
 * being worked on, rendering the same as another, being checked, and at rest
 * its first tag.
 */
function RowBadge({
  aside,
  carrying,
  comparing,
  same,
  scanning,
  tag,
  working,
}: {
  /** How the badge steps aside for the row's buttons, a drag or a rename. */
  aside: string;
  /** Rows folded under this one while it is dragged. */
  carrying: number;
  comparing: boolean;
  same: readonly string[] | undefined;
  scanning: boolean;
  tag: string | undefined;
  working: boolean;
}) {
  return carrying > 0 ? (
    <span
      className={`shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium leading-normal tabular-nums text-[#E8E8EA] ${aside}`}
    >
      +{carrying}
    </span>
  ) : comparing ? (
    <span
      className={`shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium leading-normal text-[#E8E8EA] ${aside}`}
    >
      Comparing
    </span>
  ) : working ? (
    <span
      className={`flex h-5 shrink-0 items-center gap-1 rounded bg-white/[0.04] pl-0.5 pr-1.5 text-[10px] font-medium leading-none text-[#84848C]/80 ${aside}`}
    >
      <ThinkingOrb aria-label="Working on direction" size={20} state={MOOD} theme="dark" />
      Cooking
    </span>
  ) : same ? (
    <Tip
      label={`Rendered structure, layout, visual styles, media and vector geometry match ${same?.join(", ")} in a 1280 × 800 comparison.`}
    >
      <span
        className={`shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-normal text-amber-300/90 ${aside}`}
      >
        Same as {same?.length === 1 ? same?.[0] : `${same?.length} others`}
      </span>
    </Tip>
  ) : scanning ? (
    <span
      className={`flex h-5 shrink-0 items-center gap-1 rounded bg-white/[0.04] pl-0.5 pr-1.5 text-[10px] font-medium leading-none text-[#84848C]/80 ${aside}`}
    >
      <ThinkingOrb aria-label="Checking for duplicates" size={20} state={MOOD} theme="dark" />
      Cooking
    </span>
  ) : (
    tag !== undefined && (
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-normal ${aside}`}
        style={tagTone(tag)}
      >
        {tag}
      </span>
    )
  );
}

/**
 * The buttons that act on a direction, floating over the end of its row and
 * only there under the pointer or the keyboard's focus.
 */
function RowActions({
  comparing,
  dragging,
  onToggleCompare,
  renaming,
  st,
  title,
  viewing,
}: {
  comparing: boolean;
  dragging: boolean;
  onToggleCompare: () => void;
  /** This row's name is being edited, so the buttons stand down. */
  renaming: boolean;
  st: ShellState;
  title: string;
  viewing: boolean;
}) {
  return (
    <div
      className={`pointer-events-none absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ${
        renaming ? "invisible" : ""
      } ${
        dragging
          ? ""
          : "group-hover:pointer-events-auto group-hover:opacity-100 group-has-[button:focus-visible]:pointer-events-auto group-has-[button:focus-visible]:opacity-100"
      }`}
    >
      {/* Choosing the second direction belongs where the directions are.
        The active row is the left pane, so this only appears on the
        others. */}
      {title !== st.active && (
        <Tip label={comparing ? "Stop comparing" : `Compare with ${st.displayName(st.active)}`}>
          <button
            aria-label={
              comparing
                ? `Stop comparing ${st.displayName(title)}`
                : `Compare ${st.displayName(title)} with ${st.displayName(st.active)}`
            }
            aria-pressed={comparing}
            className={`${ICON_BUTTON} ${comparing ? "text-white" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCompare();
            }}
            type="button"
          >
            <PIcon d={P.split} />
          </button>
        </Tip>
      )}
      {/* The reflex copy: someone says "show me" and this goes into the
        message. The reference is the deliberate one, and it lives here
        too now: both copies are of this direction, so both belong on
        its row rather than one of them squatting under the composer.
        None of the four for a viewer: a link would only work in their
        own browser, and the rest change a rail that is not theirs. */}
      {!viewing && (
        <>
          <Tip
            label={
              st.copied?.kind === "link" && st.copied.title === title
                ? "Copied"
                : "Copy preview link"
            }
          >
            <button
              aria-label={`Copy the preview link to the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.copyLink(title)}
              type="button"
            >
              {st.copied?.kind === "link" && st.copied.title === title ? (
                <span className="text-[10px] text-emerald-300">✓</span>
              ) : (
                <PIcon d={P.link} />
              )}
            </button>
          </Tip>
          <Tip
            label={
              st.copied?.kind === "reference" && st.copied.title === title ? (
                "Copied"
              ) : (
                <>
                  <span className="block">Copy a detailed reference.</span>
                  <span className="block">For a teammate or an agent.</span>
                </>
              )
            }
          >
            <button
              aria-label={`Copy a detailed reference to the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.copyReference(title)}
              type="button"
            >
              {st.copied?.kind === "reference" && st.copied.title === title ? (
                <span className="text-[10px] text-emerald-300">✓</span>
              ) : (
                <PIcon d={P.copy} size={12} />
              )}
            </button>
          </Tip>
          <Tip label="Rename">
            <button
              aria-label={`Rename the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.startRename(title)}
              type="button"
            >
              <PIcon d={P.pencil} size={12} />
            </button>
          </Tip>
          <Tip label="Remove from list">
            <button
              aria-label={`Remove the ${st.displayName(title)} direction from the list`}
              className={ICON_BUTTON}
              onClick={() => st.hide(title)}
              type="button"
            >
              <PIcon d={P.trash} size={12} />
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}

/**
 * One direction in the rail: its place in the lineage, its name and note, the
 * badge that says what is happening to it, and the buttons that act on it.
 *
 * It holds no state. What the rail knows about a row arrives as props, and
 * what a row does goes back through them, so the rail stays the one place
 * that decides order, selection and what is on the stage.
 */
export function RailRow({
  arriving,
  comparing,
  crumbBloom,
  drag,
  dragMeta,
  dragging,
  freshFor,
  gutter,
  index,
  insets,
  lit,
  onEnter,
  onFold,
  onOpenAlone,
  onPointerDown,
  onToggleCompare,
  same,
  scanning,
  shiftFor,
  st,
  tint,
  title,
  viewing,
  working,
}: {
  /** Whether this row, or one folded under it, has only just appeared. */
  arriving: (title: string) => boolean;
  /** This row is the right-hand pane of a comparison. */
  comparing: boolean;
  crumbBloom: { nonce: number; title: string };
  drag: Drag | null;
  dragMeta: React.RefObject<DragMeta | null>;
  dragging: boolean;
  /** The segments of this row's line that have not been drawn yet. */
  freshFor: (title: string) => Set<Segment> | undefined;
  gutter: number;
  index: number;
  insets: { root: number; variant: number };
  lit: ReadonlySet<Segment> | undefined;
  onEnter: (row: HTMLLIElement) => void;
  onFold: () => void;
  onOpenAlone: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onToggleCompare: () => void;
  /** Directions that render the same as this one. */
  same: readonly string[] | undefined;
  /** This row is being checked for duplicates right now. */
  scanning: boolean;
  shiftFor: (index: number) => number;
  st: ShellState;
  tint: string;
  title: string;
  viewing: boolean;
  /** An agent is changing this direction. */
  working: boolean;
}) {
  const isActive = title === st.active;
  const isWorking = working;
  const preview = st.previewFor(title);
  const isDragged = dragging && drag?.title === title;
  const shift = dragging && !isDragged ? shiftFor(index) : 0;
  const meta = st.rowMeta.get(title);
  const depth = meta?.depth ?? 0;
  const isVariant = depth > 0;

  // Rows folded for the drag carry their subtree as a count, so a family
  // moving as one row still says how much is moving. A root already says
  // it beside its fold control.
  const carrying =
    dragging && st.dragFolded.has(title) && (meta?.variants ?? 0) === 0
      ? (meta?.descendants ?? 0)
      : 0;

  // How the row shows its depth. With lineage on the rail the card itself
  // starts where its text column begins, so the graph lives in the gutter
  // outside every card: a root's card sits past its mark and the forks that
  // leave it, a variant's past the lanes to its left. The two columns come
  // from what the gutter draws, and are zero when it draws nothing.
  const rowIndent = isVariant ? insets.variant : insets.root;
  const variantCount = meta?.variants ?? 0;
  const folded = meta?.folded ?? false;
  // Renaming edits the name where it sits. Replacing the whole row with a
  // form meant every neighbour moved, the note vanished, and the row you
  // were aiming at stopped looking like itself. The field carries the
  // title's own metrics instead, so nothing below it shifts by a pixel.
  const renamingThis = st.renaming === title;

  // The end of the title line is contested: at rest it holds the badge, and
  // under the pointer the buttons, which want more room than the badge
  // takes. The badge leaves the flow rather than just fading, so the name
  // gets every pixel the buttons don't use instead of the badge's width
  // being stranded invisibly behind them. A dragged row keeps its badge:
  // it is being moved, not acted on, and its buttons stay away. So does a
  // row being renamed, where the badge is the field's right-hand wall —
  // taking it out from under the pointer would resize the field mid-word.
  // A row pushed past where it can go says why in the badge's corner, so
  // the badge fades out under it and back when the row is let go.
  const badgeAside =
    isDragged && drag?.blocked
      ? "opacity-0 transition-opacity duration-150"
      : dragging || renamingThis
        ? "transition-opacity duration-150"
        : "group-hover:hidden group-has-[button:focus-visible]:hidden";

  return (
    <li
      className={`group relative ${
        isDragged
          ? `z-30 ${
              drag?.settling
                ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
                : ""
            }`
          : "z-10"
      } ${
        dragging && !isDragged
          ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
          : ""
      }`}
      data-title={title}
      onPointerEnter={(event) => onEnter(event.currentTarget)}
      style={{
        ...(isDragged
          ? { transform: `translateY(${drag?.dy ?? 0}px)` }
          : shift
            ? { transform: `translateY(${shift}px)` }
            : {}),
        paddingLeft: rowIndent,
        viewTransitionName: `row-${rowIdent(title)}`,
      }}
    >
      {/* Pushed past where it can go, the row says why, in the corner the
          badges use, and only while it is being pushed. */}
      {isDragged && drag?.reason != null ? (
        <span
          aria-live="polite"
          className={`pointer-events-none absolute right-2 top-1.5 z-40 rounded bg-white/[0.1] px-1.5 py-0.5 text-[10px] font-medium leading-normal text-[#E8E8EA] shadow-md transition-opacity duration-150 motion-reduce:transition-none ${
            drag.blocked ? "opacity-100" : "opacity-0"
          }`}
        >
          {drag.reason}
        </span>
      ) : null}
      {/* Everything the rail cannot fit: the note in full, the direction
          this one was built from, and the change that was asked for. Only
          for a direction that records one of them, so a card never opens
          to say nothing, and never while the name is being edited. */}
      {gutter > 0 && meta?.graph ? (
        <Gutter
          active={isActive}
          arriving={arriving(title)}
          bloom={crumbBloom.title === title ? crumbBloom.nonce : 0}
          delay={Math.min(index, 12) * 28}
          family={(meta?.descendants ?? 0) > 0}
          folded={meta?.folded ?? false}
          fresh={freshFor(title)}
          lifted={isDragged}
          lit={lit}
          row={meta.graph}
          tint={tint}
          width={gutter}
          working={isWorking}
        />
      ) : null}
      <RowCard
        displayName={st.displayName}
        name={st.displayName(title)}
        preview={preview}
        quiet={renamingThis}
      >
        <div
          aria-pressed={isActive}
          className={`relative flex w-full items-start gap-2 rounded-md py-2 pl-3 pr-3 text-left transition-colors ${
            viewing ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
          } ${
            isActive
              ? "bg-[#2E2E2E] ring-1 ring-inset ring-[#D1D5DB]/40"
              : isDragged
                ? "bg-white/[0.06]"
                : ""
          } ${isDragged ? "shadow-2xl" : ""}`}
          onClick={() => {
            if (renamingThis) return;

            if (dragMeta.current?.suppressed) {
              dragMeta.current.suppressed = false;

              return;
            }

            st.setActive(title);
          }}
          onDoubleClick={(event) => {
            // The whole card opens the design, and only two things carve out
            // of it: the buttons, which have their own jobs, and the name,
            // which stops the event itself. Everything else — the note, the
            // badge, the empty space beside them — is one target.
            if (renamingThis) return;

            if (event.target instanceof Element && event.target.closest("button")) return;
            // The second click of the pair has already selected a word.
            window.getSelection()?.removeAllRanges();
            onOpenAlone();
          }}
          onKeyDown={(event) => {
            // Only when the card itself holds the focus. The rename field sits
            // inside it, and Enter and Space are the two keys it needs most:
            // taking them from the whole subtree meant Enter never committed a
            // rename, because the preventDefault here cancelled the form's own
            // submission, and a space never reached the name being typed.
            if (event.target !== event.currentTarget) return;

            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              st.setActive(title);
            }
          }}
          onPointerDown={onPointerDown}
          role="button"
          tabIndex={0}
        >
          <span className="min-w-0 flex-1">
            {/* The buttons float over the row rather than sitting in it, so
                the title line has to give up the strip they land on or a long
                name runs underneath them. Four 24px buttons and the gaps
                between them, 8px in from the edge, less the 12px the row
                already pads: 98px, or 72px on the active row, which has no
                compare button. Only while they are up — at rest the name gets
                the whole line back. */}
            <span
              className={`flex items-center gap-2 ${
                dragging || renamingThis
                  ? ""
                  : viewing
                    ? isActive
                      ? ""
                      : "group-hover:pr-[20px] group-has-[button:focus-visible]:pr-[20px]"
                    : isActive
                      ? "group-hover:pr-[72px] group-has-[button:focus-visible]:pr-[72px]"
                      : "group-hover:pr-[98px] group-has-[button:focus-visible]:pr-[98px]"
              }`}
            >
              {variantCount > 0 && (
                <Tip
                  label={
                    folded
                      ? `Show ${variantCount} variant${variantCount === 1 ? "" : "s"}`
                      : "Fold the variants away"
                  }
                >
                  <button
                    aria-expanded={!folded}
                    aria-label={`${folded ? "Show" : "Hide"} the variants of ${st.displayName(title)}`}
                    className="flex shrink-0 items-center gap-1 rounded px-0.5 py-1 text-[#84848C] transition-colors hover:text-[#E8EAED]"
                    onClick={(event) => {
                      event.stopPropagation();
                      onFold();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    <svg
                      className={`size-2.5 transition-transform duration-150 motion-reduce:transition-none ${folded ? "-rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 10 10"
                    >
                      <path d="M2 3.5 5 6.5 8 3.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {folded ? (
                      <span className="text-[10px] leading-none tabular-nums">{variantCount}</span>
                    ) : null}
                  </button>
                </Tip>
              )}
              {renamingThis ? (
                <RenameForm
                  error={st.renameError}
                  initial={st.displayName(title)}
                  label={`Rename the ${st.displayName(title)} direction`}
                  onCancel={() => st.startRename(null)}
                  onCommit={(value, via) => st.rename(title, value, via)}
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 text-sm font-medium leading-5 transition-colors duration-150 ${
                    isActive ? "text-white" : "text-[#D1D5DB] group-hover:text-[#E8EAED]"
                  }`}
                >
                  {/* Two targets share this row and the split between them is
                      the whole trick. The outer box is flex-1, so hanging the
                      gesture there made most of the card rename instead of
                      open. Hanging it on the glyphs alone was the other
                      extreme: a four-character name is a sliver to hit.

                      So the name gets a box of its own — at least 70% of the
                      line the rename field will fill, growing to fit a longer
                      name. Each padding is cancelled by an equal negative
                      margin, which buys territory without moving a pixel of
                      text or changing the row's height. It reaches to the
                      card's edge, where there is nothing to take it from,
                      except on a family root where the fold control is
                      already sitting there. What is left for opening the
                      design is the note beneath, the badge, and the last
                      third of the title line. */}
                  <span
                    className={`block w-fit min-w-[70%] max-w-full truncate -my-1 py-1 pr-2 ${
                      viewing ? "" : "cursor-text"
                    } ${variantCount > 0 ? "" : "-ml-3 pl-3"}`}
                    onDoubleClick={
                      viewing
                        ? undefined
                        : (event) => {
                            event.stopPropagation();
                            window.getSelection()?.removeAllRanges();
                            st.startRename(title);
                          }
                    }
                  >
                    {st.displayName(title)}
                  </span>
                </span>
              )}
              <RowBadge
                aside={badgeAside}
                carrying={carrying}
                comparing={comparing}
                same={same}
                scanning={scanning}
                tag={preview?.tags[0]}
                working={isWorking}
              />
            </span>
            {/* A refused name takes this line rather than adding one. The two
                are never both worth reading, and swapping them keeps the row
                the height it already was. */}
            <span
              className={`mt-0.5 line-clamp-2 block cursor-text text-xs leading-snug transition-colors ${
                renamingThis && st.renameError
                  ? "text-amber-300/90"
                  : isActive
                    ? "text-[#D1D5DB]"
                    : "text-[#84848C]"
              }`}
              id={renamingThis && st.renameError ? "leglas-rename-error" : undefined}
            >
              {renamingThis && st.renameError
                ? st.renameError
                : // A branch's own URL is a loopback address on a port picked at
                  // random, which tells a reader nothing and now appears only once
                  // the checkout is up. The branch it came from is the useful line
                  // and it is there from the start.
                  (preview?.note ??
                  (preview?.branch === undefined ? preview?.url : preview.branch))}
            </span>
          </span>
        </div>
      </RowCard>
      <RowActions
        comparing={comparing}
        dragging={dragging}
        onToggleCompare={onToggleCompare}
        renaming={renamingThis}
        st={st}
        title={title}
        viewing={viewing}
      />
    </li>
  );
}
