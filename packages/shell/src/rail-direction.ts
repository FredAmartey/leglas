/**
 * Which rail this page draws.
 *
 * An exploration of the rail itself, switched by URL the way Leglas switches
 * any project's directions: every direction renders from the one dev server,
 * and the rail as it ships stays exactly as it is, because it is the thing
 * the others are compared against. Production always answers "current",
 * whatever the URL says, so a built shell cannot show an unreleased rail.
 */

export const RAIL_DIRECTIONS = [
  "current",
  "nested",
  "lineage",
  "breadcrumb",
  "graph",
  "trace",
] as const;

export type RailDirection = (typeof RAIL_DIRECTIONS)[number];

export type RailShape = {
  /**
   * `family` flattens every descendant to one level under its family root, in
   * saved order. `lineage` puts each variant directly after the direction it
   * came from, so a chain reads top to bottom.
   */
  order: "family" | "lineage";
  /**
   * One indent for any variant, an indent per level, or none at all. A rail
   * with a graph keeps the one indent and draws its lanes inside it.
   */
  indent: "one" | "tree" | "none";
  /** The provenance line under the composer becomes the ancestry. */
  crumbs: boolean;
  /** A git-log gutter beside the titles carries the lineage. */
  graph: boolean;
  /**
   * The gutter and the crumbs answer to the pointer: a row's line back to its
   * root lights on hover, new segments draw in, and the ask opens in place.
   */
  live: boolean;
};

const SHAPES: Record<RailDirection, RailShape> = {
  current: { order: "family", indent: "one", crumbs: false, graph: false, live: false },
  nested: { order: "lineage", indent: "tree", crumbs: false, graph: false, live: false },
  lineage: { order: "lineage", indent: "one", crumbs: false, graph: false, live: false },
  breadcrumb: { order: "lineage", indent: "one", crumbs: true, graph: false, live: false },
  graph: { order: "lineage", indent: "one", crumbs: true, graph: true, live: false },
  trace: { order: "lineage", indent: "one", crumbs: true, graph: true, live: true },
};

export function resolveRailDirection(search: string, production: boolean): RailDirection {
  if (production) return "current";
  const value = new URLSearchParams(search).get("v-rail");
  return value !== null && (RAIL_DIRECTIONS as readonly string[]).includes(value)
    ? (value as RailDirection)
    : "current";
}

export function railShape(direction: RailDirection): RailShape {
  return SHAPES[direction];
}
