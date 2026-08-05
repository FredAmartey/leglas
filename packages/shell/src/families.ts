/**
 * Grouping variants under the direction they are based on.
 *
 * An exploration has structure the flat rail erased: diverge produces
 * directions, converge produces variants of one of them, and eight rows read as
 * eight siblings when the head says "four directions, one of them varied". A
 * preview may name the direction it is based on, and the rail keeps each
 * family together: the direction, then its variants indented one level.
 *
 * One visual level, deliberately. Judgment happens between siblings, not
 * across history, so a variant of a variant still displays under the family's
 * root while the recorded parent stays exact for the compare default. A full
 * lineage view is version control for designs, which is a different tool.
 */

export type FamilyRow = { title: string; depth: 0 | 1 };

const WALK_CAP = 10;

/**
 * The family root a title displays under. A missing parent promotes the title
 * to root, so hiding or removing a direction never strands its variants, and a
 * cycle resolves to wherever the walk stops rather than hanging.
 */
export function rootOf(title: string, basedOn: ReadonlyMap<string, string>): string {
  let current = title;
  for (let step = 0; step < WALK_CAP; step += 1) {
    const parent = basedOn.get(current);
    if (parent === undefined || parent === title) return current;
    current = parent;
  }
  return current;
}

/**
 * The rail's rows with family structure applied.
 *
 * Titles arrive already ordered and filtered (saved order, hidden, search).
 * Roots keep that order; each root's children follow it immediately, in their
 * own relative order. A title whose parent is not in the list stands as a
 * root, which is what makes hiding a parent behave sensibly.
 */
export function familyRows(
  titles: readonly string[],
  basedOn: ReadonlyMap<string, string>,
): FamilyRow[] {
  const present = new Set(titles);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  for (const title of titles) {
    const root = rootOf(title, basedOn);
    if (root === title || !present.has(root)) {
      roots.push(title);
    } else {
      const siblings = childrenOf.get(root);
      if (siblings) siblings.push(title);
      else childrenOf.set(root, [title]);
    }
  }

  return roots.flatMap((root): FamilyRow[] => [
    { title: root, depth: 0 },
    ...(childrenOf.get(root) ?? []).map((child): FamilyRow => ({ title: child, depth: 1 })),
  ]);
}

/**
 * Collapse applied to family rows. Children of a collapsed root are omitted;
 * a search overrides collapse entirely, because a query that matches a hidden
 * variant must be able to reveal it.
 */
export function collapseRows(
  rows: readonly FamilyRow[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
): FamilyRow[] {
  if (searching || collapsed.size === 0) return [...rows];
  let currentRoot: string | null = null;
  return rows.filter((row) => {
    if (row.depth === 0) {
      currentRoot = row.title;
      return true;
    }
    return currentRoot === null || !collapsed.has(currentRoot);
  });
}
