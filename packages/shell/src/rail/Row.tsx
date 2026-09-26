import { ThinkingOrb } from "thinking-orbs";

import { Icon } from "../agents/StatusCard.js";
import type { GenerationSlot } from "../generation/generation.js";
import { Gutter } from "../lineage/Gutter.js";
import type { Segment } from "../lineage/lineage.js";
import { EASE } from "../prefs.js";
import { ICON_BUTTON, P, PIcon, RenameForm, Tip } from "../ui/kit.js";
import { MOOD } from "../ui/orb.js";
import type { ShellState } from "../useShellState.js";
import type { Drag, DragMeta } from "./drag.js";
import { RowCard } from "./RowCard.js";
import { tagTone } from "./tags.js";

/** A direction Leglas is building: its slot, and what the row's buttons do about it. */
export type RowSlot = {
  slot: GenerationSlot;
  /** Who is building it, by name. */
  agent: string;
  /** One of its buttons is waiting on the server. */
  acting: boolean;
  onReplace: () => void;
  onRetry: () => void;
  onStop: () => void;
};

/** A title as a CSS identifier, for a row's view-transition-name. */
function rowIdent(title: string): string {
  let hash = 0;

  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return Math.abs(hash).toString(36);
}

/** A direction Leglas is building, failed or stopped: its badge in place of the row's tag. */
function SlotBadge({ agent, aside, slot }: { agent: string; aside: string; slot: GenerationSlot }) {
  return slot.state === "building" || slot.state === "checking" ? (
    <span
      className={`flex h-5 shrink-0 items-center gap-1 rounded bg-white/[0.04] pl-0.5 pr-1.5 text-[10px] font-medium leading-none text-[#84848C]/80 ${aside}`}
    >
      <ThinkingOrb
        aria-label={
          slot.state === "building"
            ? `${agent} is building this direction`
            : "Checking this direction renders"
        }
        size={20}
        state={MOOD}
        theme="dark"
      />
      {slot.state === "building" ? "Building" : "Checking"}
    </span>
  ) : slot.state === "failed" ? (
    <Tip label={slot.failure?.message ?? "It did not build."}>
      <span
        className={`shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-normal text-amber-300/90 ${aside}`}
      >
        Failed
      </span>
    </Tip>
  ) : (
    <span
      className={`shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium leading-normal text-[#84848C] ${aside}`}
    >
      Stopped
    </span>
  );
}

/**
 * What's happening to a direction, in its row's corner, most pressing first:
 * carried by a drag, compared, built by Leglas, worked on, a duplicate, being
 * checked, else its first tag.
 */
function RowBadge({
  agent,
  aside,
  carrying,
  comparing,
  same,
  scanning,
  slot,
  tag,
  working,
}: {
  /** Who is building the row's direction, when Leglas is. */
  agent: string;
  /** How the badge steps aside for the row's buttons, a drag or a rename. */
  aside: string;
  /** Rows folded under this one while it is dragged. */
  carrying: number;
  comparing: boolean;
  same: readonly string[] | undefined;
  scanning: boolean;
  slot: GenerationSlot | null;
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
  ) : slot !== null && slot.state !== "ready" ? (
    <SlotBadge agent={agent} aside={aside} slot={slot} />
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

/** The buttons on a direction that is not ready: stop it, or build it again, try another idea, remove it. */
function SlotActions({
  className,
  name,
  onRemove,
  slot,
}: {
  className: string;
  name: string;
  onRemove: () => void;
  slot: RowSlot;
}) {
  const running = slot.slot.state === "building" || slot.slot.state === "checking";

  return (
    <div className={className}>
      {running ? (
        <Tip label="Stop building">
          <button
            aria-label={`Stop building the ${name} direction`}
            className={`${ICON_BUTTON} disabled:cursor-wait disabled:opacity-40`}
            disabled={slot.acting}
            onClick={(event) => {
              event.stopPropagation();
              slot.onStop();
            }}
            type="button"
          >
            <span className="block size-2 rounded-[2px] bg-current" />
          </button>
        </Tip>
      ) : (
        <>
          <Tip label={slot.slot.state === "failed" ? "Try again" : "Build it"}>
            <button
              aria-label={`Build the ${name} direction again`}
              className={`${ICON_BUTTON} disabled:cursor-wait disabled:opacity-40`}
              disabled={slot.acting}
              onClick={(event) => {
                event.stopPropagation();
                slot.onRetry();
              }}
              type="button"
            >
              <Icon>
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                <path d="M13.7 1.8v2.7H11" />
              </Icon>
            </button>
          </Tip>
          <Tip label="Try a new idea">
            <button
              aria-label={`Replace the ${name} direction with a new idea`}
              className={`${ICON_BUTTON} disabled:cursor-wait disabled:opacity-40`}
              disabled={slot.acting}
              onClick={(event) => {
                event.stopPropagation();
                slot.onReplace();
              }}
              type="button"
            >
              <Icon>
                <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z" />
              </Icon>
            </button>
          </Tip>
          <Tip label="Remove from list">
            <button
              aria-label={`Remove the ${name} direction from the list`}
              className={ICON_BUTTON}
              onClick={onRemove}
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
 * The buttons that act on a direction, floating over the row's end, only under
 * the pointer or keyboard focus.
 */
function RowActions({
  comparing,
  dragging,
  onToggleCompare,
  renaming,
  slot,
  st,
  title,
  viewing,
}: {
  comparing: boolean;
  dragging: boolean;
  onToggleCompare: () => void;
  /** This row's name is being edited, so the buttons stand down. */
  renaming: boolean;
  slot: RowSlot | null;
  st: ShellState;
  title: string;
  viewing: boolean;
}) {
  const floating = `pointer-events-none absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ${
    renaming ? "invisible" : ""
  } ${
    dragging
      ? ""
      : "group-hover:pointer-events-auto group-hover:opacity-100 group-has-[button:focus-visible]:pointer-events-auto group-has-[button:focus-visible]:opacity-100"
  }`;

  // A direction being built, failed or stopped has nothing to compare, link or
  // rename yet; its buttons are about the build.
  if (slot !== null && slot.slot.state !== "ready" && !viewing) {
    return (
      <SlotActions
        className={floating}
        name={st.displayName(title)}
        onRemove={() => st.hide(title)}
        slot={slot}
      />
    );
  }

  return (
    <div className={floating}>
      {/* Choosing the second direction happens where the directions are. The
          active row is the left pane, so this shows on the others only. */}
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
      {/* The reflex copy for "show me", and the deliberate reference beside
          it; both copy this direction, so both live on its row. None of the
          four for a viewer: a link would only work in their browser, and the
          rest change a rail that isn't theirs. */}
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
 * One direction in the rail: its lineage place, name and note, its badge and
 * its buttons. Stateless: everything arrives as props and goes back through
 * them, so the rail alone decides order, selection and the stage.
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
  onPick,
  onPointerDown,
  onToggleCompare,
  same,
  scanning,
  shiftFor,
  st,
  tint,
  title,
  slot,
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
  /** The row was picked, whether or not its direction was already on the stage. */
  onPick: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onToggleCompare: () => void;
  /** Directions that render the same as this one. */
  same: readonly string[] | undefined;
  /** This row is being checked for duplicates right now. */
  scanning: boolean;
  shiftFor: (index: number) => number;
  /** Set while Leglas builds this direction, or after it failed or was stopped. */
  slot: RowSlot | null;
  st: ShellState;
  tint: string;
  title: string;
  viewing: boolean;
  /** An agent is changing this direction. */
  working: boolean;
}) {
  const isActive = title === st.active;
  const building = slot?.slot.state === "building" || slot?.slot.state === "checking";
  const isWorking = working || building;
  const preview = st.previewFor(title);
  const isDragged = dragging && drag?.title === title;
  const shift = dragging && !isDragged ? shiftFor(index) : 0;
  const meta = st.rowMeta.get(title);
  const depth = meta?.depth ?? 0;
  const isVariant = depth > 0;

  // Rows folded for the drag carry their subtree as a count, so a family moving
  // as one row says how much is moving. A root already says it by its fold
  // control.
  const carrying =
    dragging && st.dragFolded.has(title) && (meta?.variants ?? 0) === 0
      ? (meta?.descendants ?? 0)
      : 0;

  // How the row shows depth. With lineage on, the card starts at its text
  // column and the graph sits in the gutter outside every card; both columns
  // come from what the gutter draws, zero when it draws nothing.
  const rowIndent = isVariant ? insets.variant : insets.root;
  const variantCount = meta?.variants ?? 0;
  const folded = meta?.folded ?? false;
  // Renaming edits the name in place. Swapping the row for a form moved every
  // neighbour and hid the note; the field carries the title's own metrics so
  // nothing shifts.
  const renamingThis = st.renaming === title;

  // The end of the title line holds the badge at rest and the wider buttons
  // under the pointer. The badge leaves the flow, not just fades, so the name
  // gets every pixel the buttons don't use. A dragged row keeps its badge
  // (moved, not acted on), and so does a row being renamed, where the badge is
  // the field's right wall. A row pushed past where it can go shows why in the
  // badge's corner.
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
      {/* Pushed past where it can go, the row says why in the badge corner,
          only while pushed. */}
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
      {/* What the rail can't fit: the full note, the parent and the change
          asked for. Only for directions that record one, never while
          renaming. */}
      {gutter > 0 && meta?.graph ? (
        <Gutter
          active={isActive}
          arriving={arriving(title)}
          bloom={crumbBloom.title === title ? crumbBloom.nonce : 0}
          delay={Math.min(index, 12) * 28}
          family={(meta?.descendants ?? 0) > 0}
          folded={meta?.folded ?? false}
          fresh={freshFor(title)}
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

            onPick();
            st.setActive(title);
          }}
          onDoubleClick={(event) => {
            // The whole card opens the design, except the buttons and the name,
            // which stops the event itself.
            if (renamingThis) return;

            if (event.target instanceof Element && event.target.closest("button")) return;
            // The second click already selected a word.
            window.getSelection()?.removeAllRanges();
            onOpenAlone();
          }}
          onKeyDown={(event) => {
            // Only when the card itself has focus. Taking Enter and Space from
            // the whole subtree broke the rename field: Enter never committed
            // and spaces never arrived.
            if (event.target !== event.currentTarget) return;

            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onPick();
              st.setActive(title);
            }
          }}
          onPointerDown={onPointerDown}
          role="button"
          tabIndex={0}
        >
          <span className="min-w-0 flex-1">
            {/* The buttons float over the row, so the title gives up the
                strip they land on or a long name runs under them: four 24px
                buttons plus gaps, 8px in from the edge, less the row's 12px
                padding, is 98px (72px on the active row, which has no
                compare). Only while they're up. */}
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
                  {/* Two targets share this row. Hanging rename on the
                      flex-1 box made most of the card rename instead of
                      open; hanging it on the glyphs made a short name a
                      sliver to hit. So the name gets its own box, at least
                      70% of the line, growing with the name, with padding
                      cancelled by negative margin so text and row height
                      don't move. It reaches the card's edge except on a
                      family root, where the fold control sits. Opening the
                      design gets the note, the badge and the rest of the
                      title line. */}
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
                agent={slot?.agent ?? ""}
                aside={badgeAside}
                carrying={carrying}
                comparing={comparing}
                same={same}
                scanning={scanning}
                slot={slot?.slot ?? null}
                tag={preview?.tags[0]}
                working={isWorking}
              />
            </span>
            {/* A refused name replaces this line rather than adding one,
                keeping the row's height. */}
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
                : // A branch's own URL is a random loopback port; its branch is the useful line.
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
        slot={slot}
        st={st}
        title={title}
        viewing={viewing}
      />
    </li>
  );
}
