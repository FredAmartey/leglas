import { forkCurve, forkKnee, type LineageRow, type RowMeta, type Segment } from "./lineage.js";

/**
 * The lineage beside the titles, drawn like `git log --graph`. Titles stay
 * aligned at any depth; a chain is one line, and a fork curves into its own
 * lane until its row. Each row draws its slice and reaches into the gaps, so
 * strokes meet across rows and follow a dragged row. A slice can light per
 * segment (one line back to its root) and draw in when new; the running light
 * is drawn over the whole rail, see Trail.
 *
 * Marks only where the history changes shape: a line's start or end, a fork,
 * and the row on stage. Elsewhere the line passes a hair tick. A direction on
 * no line gets nothing, except a folded root, which keeps its mark with three
 * fading dots below.
 *
 * The vocabulary: filled dot for start, end or fork; hair tick for a row
 * passed; ring for the row on stage; breathing mark for an agent working now. A
 * family's trunk is a shade heavier than its branches.
 */

/** Lanes sit this far apart. */
const LANE = 10;

/** The first lane sits this far in from the row's edge, clear of the fold control beside a root's name. */
const PAD = 4;

/** The indent a variant already has; the lanes live inside it and the titles never move. */
const INDENT = 44;

/** The row's vertical padding, which the slice has to cover to meet its neighbours. */
const ROW_PAD = 8;

/** Half the title line: the mark sits on the name, not on the note. */
const HALF_LINE = 10;

/** Past the row into the gap between rows, so one stroke reads across both. */
const REACH = 4;

const LINE = "#4A4A54";

/** A branch sits a shade behind the trunk it left. */
const LINE_BRANCH = "#41414A";

const LINE_LIT = "#8E8E98";

const MARK = "#7C7C85";

const MARK_LIT = "#D1D5DB";

const MARK_ACTIVE = "#E8E8EA";

const EASE = "160ms cubic-bezier(0.2, 0.7, 0.2, 1)";

/** The gutter's width for the widest lane any row touches; zero when none does. */
export function gutterWidth(lanes: number): number {
  return lanes < 0 ? 0 : Math.max(INDENT, PAD + lanes * LANE + 10);
}

/** A root's card starts here once anything is drawn in the gutter: past its mark and a fork to the next lane. */
const ROOT_INSET = 16;

/** A variant's card starts here, so its title keeps the indent it always had. */
const VARIANT_INSET = INDENT - 12;

/** A line or a fork's knee keeps this much dark between itself and a card's edge. */
const LINE_CLEAR = 2;

/** A ring around a mark keeps this much: the ring's own radius and a little more. */
const RING_CLEAR = 8;

/**
 * Where cards start, so everything the gutter draws stays outside them: one
 * column for roots, one for variants. Both grow when a family opens more lanes,
 * and both are zero on a rail that draws nothing.
 */
export type RailInsets = { root: number; variant: number };

export function railInsets(meta: ReadonlyMap<string, RowMeta>): RailInsets {
  let root = 0;
  let variant = 0;

  for (const { descendants, graph } of meta.values()) {
    if (graph === null) continue;

    if (!(graph.fromAbove || graph.toBelow || graph.forks.length > 0 || descendants > 0)) continue;

    if (graph.depth === 0) {
      // A root sits on lane 0; only the forks leaving it reach further right.
      root = Math.max(root, ROOT_INSET, PAD + Math.max(0, ...graph.forks) * LANE + LINE_CLEAR);
    } else {
      const reach = Math.max(graph.lane, ...graph.forks, ...graph.through);
      variant = Math.max(variant, VARIANT_INSET, PAD + reach * LANE + RING_CLEAR);
    }
  }

  // A family anywhere puts every root past the trunk column, lone ones too.
  if (variant > 0) root = Math.max(root, ROOT_INSET);

  return { root, variant };
}

type Piece =
  | {
      key: string;
      lane: number;
      segment: Segment;
      kind: "line";
      x: number;
      y1: number;
      y2: number | string;
    }
  | { key: string; lane: number; segment: Segment; kind: "path"; d: string };

export function Gutter({
  active,
  arriving = false,
  bloom = 0,
  delay = 0,
  family = false,
  folded = false,
  fresh,
  lit,
  row,
  tint = "#FB7185",
  width,
  working = false,
}: {
  active: boolean;
  /** A direction just landed here, or attached itself here; the mark blooms once. */
  arriving?: boolean;
  /** A nonce; each change blooms the mark once, for a crumb resting on this row. */
  bloom?: number;
  /** The row has rows beneath it, folded away or not. */
  family?: boolean;
  /** The row's family is folded away beneath it. */
  folded?: boolean;
  /** Stagger for a slice drawing in, so a whole rail cascades rather than pops. */
  delay?: number;
  /** Segments that were not there a moment ago and should draw themselves in. */
  fresh?: ReadonlySet<Segment> | undefined;
  /** Segments on the line being traced back to its root. */
  lit?: ReadonlySet<Segment> | undefined;
  row: LineageRow;
  /** The light's colour, for blooms and a working mark's breath. */
  tint?: string;
  width: number;
  /** An agent is working on this direction now. */
  working?: boolean;
}) {
  const x = (lane: number) => PAD + lane * LANE;
  const cx = x(row.lane);
  const cy = REACH + ROW_PAD + HALF_LINE;
  const overflow = REACH;
  const on = (segment: Segment) => lit?.has(segment) ?? false;
  const markLit = on("mark");
  /** Whether any line of this row's own runs through it. */
  const onALine = row.fromAbove || row.toBelow || row.forks.length > 0 || family;
  // Where the history changes shape, so a dot says something the row's position
  // doesn't: a line's start and end, a fork, and the row being looked at.
  const junction = active || row.forks.length > 0 || !row.fromAbove || !row.toBelow;
  // A working mark is never a hair tick: a breath needs something to breathe.
  const markRadius = junction ? (row.depth === 0 ? 3.5 : 3) : working ? 3 : 1.5;

  // The ring on the row on stage is hollow, so the line stops at its edge; a
  // filled dot hides the line anyway.
  const clear = active ? markRadius + 5 : 0;
  const pieces: Piece[] = [];

  for (const lane of row.through) {
    pieces.push({
      key: `t${lane}`,
      lane,
      segment: `through:${lane}`,
      kind: "line",
      x: x(lane),
      y1: 0,
      y2: "100%",
    });
  }

  if (row.fromAbove)
    pieces.push({
      key: "a",
      lane: row.lane,
      segment: "above",
      kind: "line",
      x: cx,
      y1: 0,
      y2: cy - clear,
    });

  if (row.toBelow)
    pieces.push({
      key: "b",
      lane: row.lane,
      segment: "below",
      kind: "line",
      x: cx,
      y1: cy + clear,
      y2: "100%",
    });

  for (const lane of row.forks) {
    // The curve leaves the mark's centre; on the row on stage its first stretch
    // is cut to start outside the ring.
    const knee = forkKnee(cx, cy, x(lane));
    const curve = forkCurve(cx, cy, x(lane), clear);

    if (curve !== "")
      pieces.push({ key: `fc${lane}`, lane, segment: `fork:${lane}`, kind: "path", d: curve });
    pieces.push({
      key: `ft${lane}`,
      lane,
      segment: `fork:${lane}`,
      kind: "line",
      x: x(lane),
      y1: knee,
      y2: "100%",
    });
  }

  const draw = (
    piece: Piece,
    extra: React.SVGProps<SVGLineElement> & React.SVGProps<SVGPathElement>,
  ) =>
    piece.kind === "line" ? (
      <line
        key={piece.key}
        pathLength={1}
        x1={piece.x}
        x2={piece.x}
        y1={piece.y1}
        y2={piece.y2}
        {...extra}
      />
    ) : (
      <path d={piece.d} key={piece.key} pathLength={1} {...extra} />
    );

  const strokeOf = (piece: Piece) => ({
    className: fresh?.has(piece.segment) ? "leglas-draw" : undefined,
    style: {
      animationDelay: `${delay}ms`,
      stroke: on(piece.segment) ? LINE_LIT : piece.lane > 0 ? LINE_BRANCH : LINE,
      transition: `stroke ${EASE}`,
    },
  });

  const landed = arriving;

  // Laid over the row's left padding, which railInsets sizes so the card starts
  // past everything drawn here.
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" style={{ width }}>
      <svg
        className="absolute left-0 overflow-visible [shape-rendering:geometricPrecision]"
        fill="none"
        strokeWidth={1.25}
        style={{ height: `calc(100% + ${overflow * 2}px)`, top: -overflow, width }}
      >
        {pieces.map((piece) => draw(piece, strokeOf(piece)))}
        {onALine && (
          <>
            {active && (
              <circle
                cx={cx}
                cy={cy}
                fill="none"
                r={markRadius + 2.5}
                stroke={MARK_ACTIVE}
                strokeWidth={1.25}
                style={{ transition: `r ${EASE}` }}
              />
            )}
            <circle
              className={working ? "leglas-breathe" : fresh?.has("mark") ? "leglas-pop" : undefined}
              cx={cx}
              cy={cy}
              data-mark=""
              fill={working ? tint : active ? MARK_ACTIVE : markLit ? MARK_LIT : MARK}
              r={active ? Math.max(2, markRadius - 1) : markRadius}
              stroke="none"
              style={{ animationDelay: `${delay + 120}ms`, transition: `fill ${EASE}, r ${EASE}` }}
            />
            {folded &&
              [8, 14, 20].map((below, index) => (
                <circle
                  cx={cx}
                  cy={cy + below}
                  fill={MARK}
                  key={below}
                  opacity={0.6 - index * 0.18}
                  r={1}
                  stroke="none"
                />
              ))}
            {(landed || bloom > 0) && (
              <circle
                className="leglas-bloom"
                cx={cx}
                cy={cy}
                fill={tint}
                key={`bloom-${bloom}-${landed ? "landed" : ""}`}
                r={markRadius}
                stroke="none"
              />
            )}
          </>
        )}
      </svg>
    </span>
  );
}
