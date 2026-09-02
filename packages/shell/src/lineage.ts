/**
 * The rail with lineage applied: each variant after the direction it came
 * from, and the shape of that tree worked out row by row for a gutter to draw.
 *
 * Family order (families.ts) flattens a family to one level under its root
 * in saved order, which is right for diverge then converge: four directions,
 * one of them varied. An exploration that iterates on the last pass instead
 * produces a chain, and flattened, six passes read as six siblings and the
 * one fact worth keeping, which pass each one came from, is gone. Lineage
 * order keeps it: a depth-first walk, siblings in saved order, so a chain
 * reads top to bottom and a fork follows the line it left.
 *
 * The gutter is drawn the way `git log --graph` draws a history: the first
 * sibling continues its parent's lane, later siblings fork into a lane of
 * their own and hold it until their row arrives. A linear chain is one line
 * and lanes are only spent where a branch actually coexists, which is what
 * lets the titles stay aligned however deep the tree is.
 */

export type LineageRow = {
  title: string;
  /** Levels below its family root, in the visible tree. */
  depth: number;
  /** Which lane its mark sits in. */
  lane: number;
  /** A line arrives from above into the mark: the row has a parent on the rail. */
  fromAbove: boolean;
  /** The line continues below the mark: the next row is this one's first child. */
  toBelow: boolean;
  /** Lanes opened at this mark for later siblings' subtrees, drawn as curves. */
  forks: number[];
  /** Lanes passing this row untouched, held for rows further down. */
  through: number[];
};

export type RowMeta = {
  depth: number;
  /** Rows in the family, for the fold control on its root; zero elsewhere. */
  variants: number;
  /** Rows beneath this one at any depth, whether or not they are showing. */
  descendants: number;
  folded: boolean;
  /** The row's place in the gutter, or null on a rail drawn in family order. */
  graph: LineageRow | null;
};

/**
 * The nearest ancestor that is on the rail. A hidden direction never strands
 * its variants; they attach to whatever above them is still showing, or stand
 * as roots when nothing is.
 */
function nearestPresent(
  title: string,
  basedOn: ReadonlyMap<string, string>,
  present: ReadonlySet<string>,
): string | null {
  const seen = new Set([title]);
  let current = basedOn.get(title);
  while (current !== undefined && !seen.has(current)) {
    if (present.has(current)) return current;
    seen.add(current);
    current = basedOn.get(current);
  }
  return null;
}

/** The visible tree: roots in saved order, each node's children in saved order. */
function lineageTree(titles: readonly string[], basedOn: ReadonlyMap<string, string>) {
  const present = new Set(titles);
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const title of titles) {
    const parent = nearestPresent(title, basedOn, present);
    if (parent === null) {
      roots.push(title);
      continue;
    }
    parentOf.set(title, parent);
    const siblings = children.get(parent);
    if (siblings) siblings.push(title);
    else children.set(parent, [title]);
  }

  // Two directions based on each other have no root between them and would
  // never be walked. Promote the first of each such ring rather than lose it.
  const reached = new Set<string>();
  const mark = (title: string) => {
    if (reached.has(title)) return;
    reached.add(title);
    for (const kid of children.get(title) ?? []) mark(kid);
  };
  for (const root of roots) mark(root);
  for (const title of titles) {
    if (reached.has(title)) continue;
    const parent = parentOf.get(title);
    if (parent !== undefined) {
      children.set(parent, (children.get(parent) ?? []).filter((kid) => kid !== title));
      parentOf.delete(title);
    }
    roots.push(title);
    mark(title);
  }

  return { children, parentOf, roots };
}

export type Rail = {
  rows: string[];
  meta: Map<string, RowMeta>;
  /** Each row's parent on the rail; roots are absent. */
  parents: Map<string, string>;
  /** Each row's children on the rail, in saved order. */
  children: Map<string, string[]>;
  roots: string[];
};

/**
 * The rail's rows in lineage order, with the fold applied and the gutter
 * worked out.
 *
 * A folded row keeps its place and drops everything beneath it. The saved
 * preference folds family roots; a drag folds the rows around the one being
 * moved. Either way the count still names the whole subtree, so a control
 * can say how much it is hiding.
 */
export function lineageRail(
  titles: readonly string[],
  basedOn: ReadonlyMap<string, string>,
  folded: ReadonlySet<string>,
): Rail {
  const tree = lineageTree(titles, basedOn);
  const size = (title: string): number =>
    (tree.children.get(title) ?? []).reduce((total, kid) => total + size(kid), 1);

  const rows: LineageRow[] = [];
  // Which lanes are held, and by whom. A lane is held from the mark that
  // opens it until the last row of the subtree drawn in it.
  const lanes: (string | null)[] = [];
  const firstFree = () => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  const visit = (title: string, depth: number, lane: number, fromAbove: boolean) => {
    const kids = folded.has(title) ? [] : (tree.children.get(title) ?? []);
    const through = lanes.flatMap((held, index) => (held !== null && index !== lane ? [index] : []));
    const forks = kids.slice(1).map((kid) => {
      const opened = firstFree();
      lanes[opened] = kid;
      return opened;
    });
    rows.push({ title, depth, lane, fromAbove, toBelow: kids.length > 0, forks, through });
    if (kids.length === 0) {
      lanes[lane] = null;
      return;
    }
    visit(kids[0] as string, depth + 1, lane, true);
    kids.slice(1).forEach((kid, index) => visit(kid, depth + 1, forks[index] as number, true));
  };

  for (const root of tree.roots) {
    const lane = firstFree();
    lanes[lane] = root;
    visit(root, 0, lane, false);
  }

  const meta = new Map<string, RowMeta>(
    rows.map((row) => [
      row.title,
      {
        depth: row.depth,
        variants: row.depth === 0 ? size(row.title) - 1 : 0,
        descendants: size(row.title) - 1,
        folded: folded.has(row.title),
        graph: row,
      },
    ]),
  );
  return {
    rows: rows.map((row) => row.title),
    meta,
    parents: tree.parentOf,
    children: tree.children,
    roots: tree.roots,
  };
}

/**
 * Move a direction among its siblings in the saved order.
 *
 * Only relative order between siblings shows on a lineage rail, so putting
 * the title just before the sibling it should precede is enough, wherever
 * their families' other rows sit in the flat list. With no sibling to go
 * before, it lands after the last of them. A hidden sibling keeps its place
 * in the list and stays hidden.
 */
export function reorderAmongSiblings(
  order: readonly string[],
  titles: readonly string[],
  title: string,
  before: string | null,
  siblings: readonly string[],
): string[] {
  const list = (order.length ? order : titles).filter((entry) => entry !== title);
  const at =
    before !== null && list.includes(before)
      ? list.indexOf(before)
      : Math.max(-1, ...siblings.filter((entry) => entry !== title).map((entry) => list.indexOf(entry))) + 1;
  list.splice(at, 0, title);
  return list;
}

/**
 * The parts of a row's slice, named, so a hover can light some of them and a
 * change can draw in only the ones it added.
 */
export type Segment = "mark" | "above" | "below" | `fork:${number}` | `through:${number}`;

export function segmentsOf(row: LineageRow): Segment[] {
  const segments: Segment[] = ["mark"];
  if (row.fromAbove) segments.push("above");
  if (row.toBelow) segments.push("below");
  for (const lane of row.forks) segments.push(`fork:${lane}`);
  for (const lane of row.through) segments.push(`through:${lane}`);
  return segments;
}

/**
 * A direction's line back to its family root, as the rows it runs through,
 * root first. Only rows on the rail: a removed ancestor is not on the line.
 */
export function tracedChain(
  parents: ReadonlyMap<string, string>,
  target: string,
): string[] {
  const path = [target];
  for (
    let parent = parents.get(target);
    parent !== undefined && !path.includes(parent);
    parent = parents.get(parent)
  ) {
    path.unshift(parent);
  }
  return path;
}

/**
 * What lights when a direction is looked at: the line from its family root
 * down to it, and nothing past it. Where a direction came from is the
 * question; what was later made from it is everyone else's line.
 *
 * The root is the one exception. Nothing came before it, and a root that
 * lit only itself would read as the light having failed, so the origin
 * shows everything that came from it, every branch included.
 *
 * Nodes come root first, each parent before its children, so a walk down the
 * list is a walk down the tree; edges are the parent-to-child steps that
 * draw it. A direction with neither ancestors nor descendants is one node and
 * no edges: it is not on a line, and nothing is drawn for it.
 */
export type TracedTree = { nodes: string[]; edges: [string, string][] };

export function tracedTree(
  parents: ReadonlyMap<string, string>,
  children: ReadonlyMap<string, readonly string[]>,
  target: string,
): TracedTree {
  const up = tracedChain(parents, target);
  const nodes = [...up];
  const edges: [string, string][] = [];
  for (let index = 0; index + 1 < up.length; index += 1) {
    edges.push([up[index] as string, up[index + 1] as string]);
  }
  if (up.length > 1) return { nodes, edges };
  const seen = new Set(nodes);
  const descend = (title: string) => {
    for (const child of children.get(title) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      nodes.push(child);
      edges.push([title, child]);
      descend(child);
    }
  };
  descend(target);
  return { nodes, edges };
}

/**
 * A lineage as the segments that draw it, row by row.
 *
 * Between a parent and its child the line runs in the child's lane: straight
 * down out of the parent's mark when the child continues its lane, or out
 * along the fork the parent opened for it, then through every row in
 * between, into the child's mark from above.
 *
 * The tree arrives worked out rather than being found again here, so the
 * light running along the lineage and the line under it can never disagree
 * about where it goes.
 */
export function tracedSegments(
  rows: readonly string[],
  meta: ReadonlyMap<string, RowMeta>,
  tree: TracedTree,
): Map<string, Set<Segment>> {
  const lit = new Map<string, Set<Segment>>();
  const add = (title: string, segment: Segment) => {
    const set = lit.get(title);
    if (set) set.add(segment);
    else lit.set(title, new Set([segment]));
  };
  for (const title of tree.nodes) if (meta.has(title)) add(title, "mark");
  for (const [parent, child] of tree.edges) {
    if (!meta.has(parent) || !meta.has(child)) continue;
    const lane = meta.get(child)?.graph?.lane ?? 0;
    add(parent, meta.get(parent)?.graph?.lane === lane ? "below" : `fork:${lane}`);
    for (let row = rows.indexOf(parent) + 1; row < rows.indexOf(child); row += 1) {
      add(rows[row] as string, `through:${lane}`);
    }
    add(child, "above");
  }
  return lit;
}

/** The widest lane any row touches, or -1 when no row has a place in the gutter. */
export function widestLane(meta: ReadonlyMap<string, RowMeta>): number {
  let widest = -1;
  for (const { graph } of meta.values()) {
    if (graph === null) continue;
    widest = Math.max(widest, graph.lane, ...graph.forks, ...graph.through);
  }
  return widest;
}

/**
 * Where a direction came from, root first, the direction itself excluded.
 * Follows the recorded parents whether or not they are still on the rail: a
 * removed ancestor is still where the design came from.
 */
export function ancestry(title: string, basedOn: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set([title]);
  let current = basedOn.get(title);
  while (current !== undefined && !seen.has(current)) {
    chain.unshift(current);
    seen.add(current);
    current = basedOn.get(current);
  }
  return chain;
}

export type Crumbs = { head: string[]; hidden: string[]; tail: string[] };

/**
 * A chain longer than the line can hold keeps its two ends. The root says
 * which family this is and the parent is the comparison that matters; what
 * lies between is one gesture away.
 */
export function collapseChain(chain: readonly string[], max = 3): Crumbs {
  if (chain.length <= max) return { head: [...chain], hidden: [], tail: [] };
  return {
    head: [chain[0] as string],
    hidden: chain.slice(1, -1),
    tail: [chain[chain.length - 1] as string],
  };
}

/**
 * Where a row's mark sits, in the rail's own coordinates, and how much room
 * a line should leave around it. A dot wants the line to stop at its edge; a
 * hair tick sits in the line and wants none.
 */
export type Mark = { x: number; y: number; clear?: number };

/**
 * How a fork leaves a mark for the lane beside it. Four geometries, all
 * drawn from the mark's centre, all sharing the arc-length cut that keeps
 * the light off the dot:
 *
 * - knee: a short cubic, twelve pixels deep, the original.
 * - arc: a quarter circle the width of the lane change, leaving the mark
 *   sideways and arriving vertical, the way branch lines turn in a graph.
 * - diagonal: a straight line at forty-five degrees.
 * - tangent: an S twice the lane change deep, leaving the mark downward
 *   along the trunk and bending across.
 * - elbow: two tight quarter circles, half the lane change each, the way a
 *   transit map turns a line: down, round, across, round, down.
 * - hook: straight out sideways from the mark and a square drop into the
 *   lane, the way a file tree hangs a child off its parent.
 * - chamfer: a short drop, a forty-five degree cut across, and down; the
 *   corner of a schematic.
 * - cascade: out sideways and a long easing fall into the lane, twice the
 *   lane change deep, the softest of them.
 *
 * And a family around the S the knee and the elbow share, down, across and
 * down again, varying only its height and how the two bends are shaped:
 *
 * - knee-tight, knee-tall: the knee's cubic at eight and sixteen pixels.
 * - knee-round: the knee's depth with fuller bends.
 * - sine: the symmetric S, both bends alike, twelve pixels deep.
 * - elbow-deep: a short drop before the elbow's two quarter circles.
 * - step: quarter circles smaller than the lane change, with a straight run
 *   between them; a transit map's tighter turn.
 * - ogee, ogee-flip: two quarter circles of unequal radius, the larger
 *   first or last; the cyma of a moulding.
 */
export const FORK_KINDS = [
  "knee",
  "arc",
  "diagonal",
  "tangent",
  "elbow",
  "hook",
  "chamfer",
  "cascade",
  "knee-tight",
  "knee-tall",
  "knee-round",
  "sine",
  "elbow-deep",
  "step",
  "ogee",
  "ogee-flip",
] as const;
export type ForkKind = (typeof FORK_KINDS)[number];
/** Elbow deep, chosen over fifteen others; the rest stay reachable as switches. */
export const DEFAULT_FORK: ForkKind = "elbow-deep";

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

const at = (value: number) => Math.round(value * 100) / 100;
/** The cubic that best approximates a quarter circle. */
const KAPPA = 0.5523;

/** The fork's curve as cubic segments, and where the lane's straight run begins. */
function forkSegments(kind: ForkKind, fromX: number, fromY: number, toX: number): { segments: Cubic[]; knee: number } {
  const d = Math.abs(toX - fromX);
  const side = toX > fromX ? 1 : -1;
  switch (kind) {
    case "arc": {
      const knee = fromY + d;
      return { knee, segments: [[[fromX, fromY], [fromX + side * KAPPA * d, fromY], [toX, knee - KAPPA * d], [toX, knee]]] };
    }
    case "diagonal": {
      const knee = fromY + d;
      return {
        knee,
        segments: [[[fromX, fromY], [fromX + (side * d) / 3, fromY + d / 3], [fromX + (side * 2 * d) / 3, fromY + (2 * d) / 3], [toX, knee]]],
      };
    }
    case "tangent": {
      const knee = fromY + 2 * d;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + d], [toX, fromY + d], [toX, knee]]] };
    }
    case "elbow": {
      const r = d / 2;
      const mid: Point = [fromX + side * r, fromY + r];
      const knee = fromY + d;
      return { knee, segments: [turnOut([fromX, fromY], r, side), turnDown(mid, r, side)] };
    }
    case "hook": {
      const knee = fromY;
      return { knee, segments: [line([fromX, fromY], [toX, fromY])] };
    }
    case "chamfer": {
      const drop = 3;
      const knee = fromY + drop + d;
      return {
        knee,
        segments: [line([fromX, fromY], [fromX, fromY + drop]), line([fromX, fromY + drop], [toX, knee])],
      };
    }
    case "cascade": {
      const knee = fromY + 2 * d;
      return { knee, segments: [[[fromX, fromY], [fromX + side * d, fromY], [toX, fromY + 0.8 * d], [toX, knee]]] };
    }
    case "knee-tight": {
      const knee = fromY + 8;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + 6], [toX, fromY + 2], [toX, knee]]] };
    }
    case "knee-tall": {
      const knee = fromY + 16;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + 12], [toX, fromY + 4], [toX, knee]]] };
    }
    case "knee-round": {
      const knee = fromY + 12;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + 7.2], [toX, fromY + 4.8], [toX, knee]]] };
    }
    case "sine": {
      const knee = fromY + 12;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + 6], [toX, fromY + 6], [toX, knee]]] };
    }
    case "elbow-deep": {
      const drop = 4;
      const r = d / 2;
      const top: Point = [fromX, fromY + drop];
      const mid: Point = [fromX + side * r, fromY + drop + r];
      const knee = fromY + drop + d;
      return { knee, segments: [line([fromX, fromY], top), turnOut(top, r, side), turnDown(mid, r, side)] };
    }
    case "step": {
      const r = Math.min(3, d / 2);
      const run = d - 2 * r;
      const a: Point = [fromX + side * r, fromY + r];
      const b: Point = [a[0] + side * run, a[1]];
      const knee = fromY + 2 * r;
      return {
        knee,
        segments: run > 0 ? [turnOut([fromX, fromY], r, side), line(a, b), turnDown(b, r, side)] : [turnOut([fromX, fromY], r, side), turnDown(a, r, side)],
      };
    }
    case "ogee":
    case "ogee-flip": {
      const r1 = kind === "ogee" ? 0.7 * d : 0.3 * d;
      const r2 = d - r1;
      const mid: Point = [fromX + side * r1, fromY + r1];
      const knee = fromY + d;
      return { knee, segments: [turnOut([fromX, fromY], r1, side), turnDown(mid, r2, side)] };
    }
    default: {
      const knee = fromY + 12;
      return { knee, segments: [[[fromX, fromY], [fromX, fromY + 9], [toX, fromY + 3], [toX, knee]]] };
    }
  }
}

/** Where a fork of this kind has finished changing lane. */
export function forkKnee(kind: ForkKind, fromX: number, fromY: number, toX: number): number {
  return forkSegments(kind, fromX, fromY, toX).knee;
}

/** A quarter circle from heading down to heading sideways, as a cubic. */
const turnOut = ([x, y]: Point, r: number, side: number): Cubic => [
  [x, y],
  [x, y + KAPPA * r],
  [x + side * (r - KAPPA * r), y + r],
  [x + side * r, y + r],
];
/** A quarter circle from heading sideways to heading down, as a cubic. */
const turnDown = ([x, y]: Point, r: number, side: number): Cubic => [
  [x, y],
  [x + side * KAPPA * r, y],
  [x + side * r, y + r - KAPPA * r],
  [x + side * r, y + r],
];

/** A straight stretch as a cubic, so every geometry is a list of cubics. */
const line = (a: Point, b: Point): Cubic => [
  a,
  [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
  [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3],
  b,
];

const cubicAt = ([p0, p1, p2, p3]: Cubic, t: number): Point => {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
};

/** The part of a cubic from t to its end, by de Casteljau. */
function cubicFrom([p0, p1, p2, p3]: Cubic, t: number): Cubic {
  const lerp = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p01 = lerp(p0, p1);
  const p12 = lerp(p1, p2);
  const p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  return [lerp(p012, p123), p123, p23, p3];
}

/**
 * A fork's curve from a mark to the lane beside it, as path commands
 * starting with a move, less its first `skip` pixels of arc.
 *
 * The gutter draws this curve from the mark's centre; the light draws the
 * same curve but must stop clear of the dot. Cutting by arc length keeps the
 * two on top of each other, where moving the light's start point down would
 * draw a second, lower curve beside the first. The cut splits the curve at
 * the parameter that arc length falls at, which keeps what remains exactly
 * the same shape. An empty string means the skip ate the whole curve.
 */
export function forkCurve(kind: ForkKind, fromX: number, fromY: number, toX: number, skip = 0): string {
  const { segments } = forkSegments(kind, fromX, fromY, toX);
  let remaining = skip;
  const kept: Cubic[] = [];
  for (const segment of segments) {
    if (remaining <= 0) {
      kept.push(segment);
      continue;
    }
    const steps = 48;
    let travelled = 0;
    let previous = segment[0];
    let cut: number | null = null;
    for (let step = 1; step <= steps; step += 1) {
      const next = cubicAt(segment, step / steps);
      const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      if (travelled + length >= remaining) {
        cut = (step - 1 + (remaining - travelled) / length) / steps;
        break;
      }
      travelled += length;
      previous = next;
    }
    if (cut === null) {
      remaining -= travelled;
      continue;
    }
    remaining = 0;
    kept.push(cubicFrom(segment, cut));
  }
  const first = kept[0];
  if (first === undefined) return "";
  const point = (p: Point) => `${at(p[0])} ${at(p[1])}`;
  return `M ${point(first[0])} ${kept.map((c) => `C ${point(c[1])}, ${point(c[2])}, ${point(c[3])}`).join(" ")}`;
}

/**
 * One path through the marks of a traced line, for the light that runs along
 * it.
 *
 * Drawn as a single path rather than per row, so the light travels by arc
 * length at one speed: rows differ in height, and a band handed from row to
 * row moves as many pixels per row as each row is tall, which is a light that
 * speeds up and slows down for no reason anyone can see.
 *
 * A step into another lane takes the same knee the gutter draws for a fork,
 * so the light follows the line that is already there rather than cutting its
 * own corner. The light stops short of each mark by the room the mark asks
 * for and sets off again past it, so a dot is met, never run through.
 */
export function trailPath(marks: readonly Mark[], fork: ForkKind = DEFAULT_FORK): string {
  let path = "";
  for (let index = 1; index < marks.length; index += 1) {
    const from = marks[index - 1] as Mark;
    const to = marks[index] as Mark;
    const skip = from.clear ?? 0;
    const start = from.y + skip;
    const end = to.y - (to.clear ?? 0);
    if (end <= start) continue;
    if (to.x === from.x) {
      path += `${path ? " " : ""}M ${from.x} ${start} L ${to.x} ${end}`;
      continue;
    }
    // The same curve the gutter draws from the mark, less the stretch the
    // mark asked to be left clear, then straight down to the child.
    const knee = forkKnee(fork, from.x, from.y, to.x);
    if (knee > end) {
      // No room for the turn before the next mark: straight there.
      path += `${path ? " " : ""}M ${from.x} ${start} L ${to.x} ${end}`;
      continue;
    }
    const curve = forkCurve(fork, from.x, from.y, to.x, skip);
    path += `${path ? " " : ""}${curve === "" ? `M ${to.x} ${knee}` : curve} L ${to.x} ${end}`;
  }
  return path;
}
