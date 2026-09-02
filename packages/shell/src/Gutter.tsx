import { forkCurve, forkKnee, type LineageRow, type Segment } from "./lineage.js";

/**
 * The lineage drawn beside the titles, the way `git log --graph` draws a
 * history. The titles stay aligned whatever the depth; a chain is one line
 * with a mark per pass, and a fork leaves it as a curve into a lane of its
 * own that runs until its row arrives.
 *
 * Each row draws its own slice and reaches into the gaps above and below, so
 * the strokes meet across rows and follow a row when it is dragged. A
 * direction with no lineage still gets its mark: every row is a node, and a
 * column that skipped some would read as a margin rather than a graph.
 *
 * A slice can be lit, segment by segment, so one direction's line back to
 * its root stands out from the rest, and a segment can draw itself in when it
 * is new, top to bottom, the way the lineage actually grew. The light that
 * runs down a lit line is drawn over the whole rail at once; see Trail.
 *
 * Marks are not stations. A dot on every row repeats what the row's own
 * position already says and turns a moving light into something stepping
 * between stops, so only the rows where the shape of the history changes
 * carry one: where a line starts or ends, where it forks, and the row on
 * stage. Everywhere else the line passes a tick barely wider than itself,
 * which keeps the row attached to its lane without punctuating it.
 *
 * A direction on no line at all gets nothing. It has no lineage to draw, and
 * a lone dot beside a name is a bullet, which says only that the row is a
 * row. A folded family root is the exception: its line is put away, not
 * gone, so the mark stays and three fading dots beneath it say where the
 * line went.
 *
 * The marks are a vocabulary. A filled dot is where a line starts, ends or
 * forks; a hair tick is a row the line passes; a ring around a dot is the
 * row on stage, "here" rather than "brighter"; a mark that breathes is a
 * direction an agent is working on right now. The trunk of a family is drawn
 * a shade heavier than its branches, so the eye finds the main line first.
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

type Piece =
  | { key: string; lane: number; segment: Segment; shape: "line"; x: number; y1: number; y2: number | string }
  | { key: string; lane: number; segment: Segment; shape: "path"; d: string };

export function Gutter({
  active,
  arriving = false,
  bloom = 0,
  delay = 0,
  family = false,
  folded = false,
  fresh,
  lifted = false,
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
  /** The row is being dragged: it carries its mark and leaves its lines behind. */
  lifted?: boolean;
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
  // Where the history changes shape, and so where a dot says something the
  // row's own position does not: the start and the end of a line, a fork,
  // and the row being looked at.
  const junction = active || row.forks.length > 0 || !row.fromAbove || !row.toBelow;
  // A working mark is never a hair tick: a breath needs something to breathe.
  const markRadius = junction ? (row.depth === 0 ? 3.5 : 3) : working ? 3 : 1.5;

  // The ring on the row on stage is hollow, so the line stops at its edge
  // rather than showing through it; a filled dot hides the line by itself.
  const clear = active ? markRadius + 5 : 0;
  const pieces: Piece[] = [];
  for (const lane of row.through) {
    pieces.push({ key: `t${lane}`, lane, segment: `through:${lane}`, shape: "line", x: x(lane), y1: 0, y2: "100%" });
  }
  if (row.fromAbove) pieces.push({ key: "a", lane: row.lane, segment: "above", shape: "line", x: cx, y1: 0, y2: cy - clear });
  if (row.toBelow) pieces.push({ key: "b", lane: row.lane, segment: "below", shape: "line", x: cx, y1: cy + clear, y2: "100%" });
  for (const lane of row.forks) {
    // The curve always leaves the mark's centre; on the row on stage its
    // first stretch is cut so it starts outside the ring.
    const knee = forkKnee(cx, cy, x(lane));
    const curve = forkCurve(cx, cy, x(lane), clear);
    if (curve !== "") pieces.push({ key: `fc${lane}`, lane, segment: `fork:${lane}`, shape: "path", d: curve });
    pieces.push({ key: `ft${lane}`, lane, segment: `fork:${lane}`, shape: "line", x: x(lane), y1: knee, y2: "100%" });
  }
  const draw = (piece: Piece, extra: React.SVGProps<SVGLineElement> & React.SVGProps<SVGPathElement>) =>
    piece.shape === "line" ? (
      <line key={piece.key} pathLength={1} x1={piece.x} x2={piece.x} y1={piece.y1} y2={piece.y2} {...extra} />
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

  // Laid over the row's own left padding and a variant's indent rather than
  // taking a column of its own, so the titles sit exactly where the rail
  // always put them.
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" style={{ width }}>
      <svg
        className="absolute left-0 overflow-visible"
        fill="none"
        shapeRendering="geometricPrecision"
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
                <circle cx={cx} cy={cy + below} fill={MARK} key={below} opacity={0.6 - index * 0.18} r={1} stroke="none" />
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
