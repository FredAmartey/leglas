/**
 * The rail with lineage applied: each variant after its parent, and the tree's
 * shape worked out per row for the gutter. Family order (families.ts) flattens
 * a family under its root, right for diverge then converge; but an iterating
 * exploration makes a chain, and flattened, six passes read as six siblings.
 * Lineage order is depth-first with siblings in saved order, so a chain reads
 * top to bottom and a fork follows the line it left.
 *
 * Like `git log --graph`: the first sibling continues its parent's lane and
 * later siblings fork into their own until their row. Lanes are spent only
 * where branches coexist, which keeps the titles aligned at any depth.
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
 * The nearest ancestor on the rail. A hidden direction never strands its
 * variants: they attach to whatever above is showing, or stand as roots.
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

  // Two directions based on each other have no root and would never be walked,
  // so the first of each ring is promoted.
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
      children.set(
        parent,
        (children.get(parent) ?? []).filter((kid) => kid !== title),
      );
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
 * The rail's rows in lineage order, folds applied, gutter worked out. A folded
 * row keeps its place and drops everything beneath it; the saved preference
 * folds family roots, a drag folds the rows around the one moving. The count
 * still names the whole subtree.
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
  // Which lanes are held and by whom: from the mark that opens a lane to the
  // last row of its subtree.
  const lanes: (string | null)[] = [];

  const firstFree = () => {
    const free = lanes.indexOf(null);

    if (free !== -1) return free;
    lanes.push(null);

    return lanes.length - 1;
  };

  const visit = (title: string, depth: number, lane: number, fromAbove: boolean) => {
    const kids = folded.has(title) ? [] : (tree.children.get(title) ?? []);

    const through = lanes.flatMap((held, index) =>
      held !== null && index !== lane ? [index] : [],
    );

    const [first, ...rest] = kids;

    const forked = rest.map((kid) => {
      const opened = firstFree();
      lanes[opened] = kid;

      return { kid, lane: opened };
    });

    rows.push({
      title,
      depth,
      lane,
      fromAbove,
      toBelow: first !== undefined,
      forks: forked.map((fork) => fork.lane),
      through,
    });

    if (first === undefined) {
      lanes[lane] = null;

      return;
    }

    visit(first, depth + 1, lane, true);

    for (const fork of forked) visit(fork.kid, depth + 1, fork.lane, true);
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
 * Moves a direction among its siblings in the saved order. Only sibling order
 * shows on a lineage rail, so placing it just before the sibling it should
 * precede is enough; with none, it goes after the last. A hidden sibling keeps
 * its place.
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
      : Math.max(
          -1,
          ...siblings.flatMap((entry) => (entry === title ? [] : [list.indexOf(entry)])),
        ) + 1;

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
export function tracedChain(parents: ReadonlyMap<string, string>, target: string): string[] {
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
 * What lights when a direction is looked at: the line from its root down to it,
 * nothing past it. The root is the exception and lights everything from it,
 * since a root lighting only itself looks broken.
 *
 * Nodes are root first, parents before children; edges are the parent-to-child
 * steps. A direction with no ancestors or descendants is one node, no edges,
 * and nothing is drawn.
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

  up.forEach((node, index) => {
    const next = up[index + 1];

    if (next !== undefined) edges.push([node, next]);
  });

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
 * A lineage as the segments that draw it, per row. Between parent and child the
 * line runs in the child's lane: straight down if the child continues the lane,
 * else along the parent's fork, then through the rows between into the child's
 * mark. The tree arrives worked out, so the light and the line can't disagree.
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

    for (const between of rows.slice(rows.indexOf(parent) + 1, rows.indexOf(child))) {
      add(between, `through:${lane}`);
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
 * Where a direction came from, root first, itself excluded. Follows recorded
 * parents even off the rail, since a removed ancestor is still the design's
 * origin.
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
 * A chain too long for the line keeps its ends: the root names the family and
 * the parent is the comparison that matters.
 */
export function collapseChain(chain: readonly string[], max = 3): Crumbs {
  if (chain.length <= max) return { head: [...chain], hidden: [], tail: [] };

  // SAFETY: the chain is longer than `max`, which is never below zero, so it
  // has a first and a last entry.
  return {
    head: [chain[0] as string],
    hidden: chain.slice(1, -1),
    tail: [chain[chain.length - 1] as string],
  };
}

/**
 * Where a row's mark sits in rail coordinates, and how much room a line leaves
 * around it: a dot wants the line to stop at its edge, a hair tick wants none.
 */
export type Mark = { x: number; y: number; clear?: number };

/**
 * How a fork leaves a mark for the next lane: a short drop, then two quarter
 * circles of half the lane change, like a transit map. Vertical in the new lane
 * fourteen pixels below the mark. Drawn from the mark's centre and shared with
 * the light, which cuts its first stretch to clear the dot.
 */
type Point = readonly [number, number];

type Cubic = readonly [Point, Point, Point, Point];

const at = (value: number) => Math.round(value * 100) / 100;

/** The cubic that best approximates a quarter circle. */
const KAPPA = 0.5523;

/** The straight drop out of the mark before the turn begins. */
const FORK_DROP = 4;

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

/** A straight stretch as a cubic, so the whole fork is a list of cubics. */
const line = (a: Point, b: Point): Cubic => [
  a,
  [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
  [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3],
  b,
];

/** The fork's curve as cubic segments, and where the lane's straight run begins. */
type Fork = { segments: Cubic[]; knee: number };

function forkSegments(fromX: number, fromY: number, toX: number): Fork {
  const d = Math.abs(toX - fromX);
  const side = toX > fromX ? 1 : -1;
  const r = d / 2;
  const top: Point = [fromX, fromY + FORK_DROP];
  const mid: Point = [fromX + side * r, fromY + FORK_DROP + r];
  const knee = fromY + FORK_DROP + d;

  return {
    knee,
    segments: [line([fromX, fromY], top), turnOut(top, r, side), turnDown(mid, r, side)],
  };
}

/** Where a fork has finished changing lane. */
export function forkKnee(fromX: number, fromY: number, toX: number): number {
  return forkSegments(fromX, fromY, toX).knee;
}

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
 * A fork's curve from a mark to the next lane as path commands, less its first
 * `skip` pixels of arc. The gutter draws it from the mark's centre; the light
 * draws the same curve but stops clear of the dot. Cutting by arc length keeps
 * the two on top of each other; moving the start down would draw a second,
 * lower curve. An empty string means the skip ate the whole curve.
 */
export function forkCurve(fromX: number, fromY: number, toX: number, skip = 0): string {
  const { segments } = forkSegments(fromX, fromY, toX);
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
 * One path through a traced line's marks, for the light. A single path so the
 * light travels at one speed by arc length; handed row to row it would speed up
 * and slow down with row heights. A lane change takes the gutter's fork knee,
 * and the light stops short of each mark by the room it asks for.
 */
export function trailPath(marks: readonly Mark[]): string {
  let path = "";

  for (let index = 1; index < marks.length; index += 1) {
    // SAFETY: `index` runs from 1 to the last position, so both neighbours
    // exist.
    const [from, to] = [marks[index - 1], marks[index]] as [Mark, Mark];
    const skip = from.clear ?? 0;
    const start = from.y + skip;
    const end = to.y - (to.clear ?? 0);

    if (end <= start) continue;

    if (to.x === from.x) {
      path += `${path ? " " : ""}M ${from.x} ${start} L ${to.x} ${end}`;
      continue;
    }

    // The gutter's curve from the mark, less the stretch the mark keeps clear,
    // then straight down to the child.
    const knee = forkKnee(from.x, from.y, to.x);

    if (knee > end) {
      // No room for the turn before the next mark: straight there.
      path += `${path ? " " : ""}M ${from.x} ${start} L ${to.x} ${end}`;
      continue;
    }

    const curve = forkCurve(from.x, from.y, to.x, skip);
    path += `${path ? " " : ""}${curve === "" ? `M ${to.x} ${knee}` : curve} L ${to.x} ${end}`;
  }

  return path;
}
