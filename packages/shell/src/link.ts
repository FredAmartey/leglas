import { ancestry } from "./lineage/lineage.js";
import type { Prefs } from "./prefs.js";
import type { Preview } from "./types.js";

/** What a link from `leglas link` asks the stage to show: one direction, or a pair. */
export type InterfaceLink = { direction: string; compare: string | null };

export function readLink(search: string): InterfaceLink | null {
  const params = new URLSearchParams(search);
  const direction = params.get("direction");

  if (direction === null || direction === "") return null;
  const compare = params.get("compare");

  return {
    direction,
    compare: compare === null || compare === "" || compare === direction ? null : compare,
  };
}

/** The address without the link, so a reload opens the rail as it always does. */
export function withoutLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("direction");
  url.searchParams.delete("compare");

  return `${url.pathname}${url.search}${url.hash}`;
}

export type OpenedLink = {
  prefs: Prefs;
  direction: string | null;
  compare: string | null;
  /** Titles the link named that this rail has no direction for. */
  missing: string[];
};

/**
 * Follows a link on this rail. A linked direction someone took off the list,
 * or folded into its family, comes back, since the link asked to see it; one
 * deleted here counts as missing, like one that never existed.
 */
export function openLink(
  link: InterfaceLink,
  prefs: Prefs,
  previews: readonly Preview[],
): OpenedLink {
  const known = (title: string | null): title is string =>
    title !== null &&
    !prefs.deleted.includes(title) &&
    previews.some((preview) => preview.title === title);

  // What the rail has goes on the stage, so a pair missing its first shows the second.
  const [direction = null, compare = null] = [link.direction, link.compare].filter(known);
  const shown = new Set([direction, compare].filter((title): title is string => title !== null));

  const basedOn = new Map(
    previews.flatMap((preview) =>
      preview.basedOn === undefined ? [] : [[preview.title, preview.basedOn] as const],
    ),
  );

  const unfold = new Set([...shown].flatMap((title) => ancestry(title, basedOn)));

  return {
    prefs:
      shown.size === 0
        ? prefs
        : {
            ...prefs,
            hidden: prefs.hidden.filter((title) => !shown.has(title)),
            collapsedFamilies: prefs.collapsedFamilies.filter((title) => !unfold.has(title)),
          },
    direction,
    compare,
    missing: [link.direction, link.compare].filter(
      (title): title is string => title !== null && !known(title),
    ),
  };
}
