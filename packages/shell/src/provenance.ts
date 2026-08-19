/**
 * Where a direction came from, for the two places that say so.
 *
 * A change made from the composer forks the direction it was sent at, so the
 * rail fills with rows nobody chose the name of. Two facts make those rows
 * accountable a fortnight later: which direction this one was built from, and
 * what was asked for in the words that were typed. The note already says what
 * a direction is; neither of these is that, and folding them into the note
 * would lose the only part an agent cannot reconstruct.
 *
 * Kept apart from the rendering because the rail shows it on hover and the
 * composer shows it for the selected direction, and the two must never
 * disagree about what there is to show.
 */

export type ProvenanceSource = {
  basedOn?: string | undefined;
  askedFor?: string | undefined;
};

export type Provenance = {
  /** The direction this one was built from, as the config recorded it. */
  basedOn: string | null;
  /** The change that was asked for, verbatim. */
  askedFor: string | null;
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * What there is to say about a direction's origin, or nothing.
 *
 * Null when neither fact is recorded, which is every direction written by
 * hand or scaffolded before this existed. The surfaces treat null as "show
 * nothing at all" rather than an empty card, because a card that opens on
 * every row to say nothing teaches people to stop reading it.
 */
export function provenanceOf(preview: ProvenanceSource | null | undefined): Provenance | null {
  const basedOn = clean(preview?.basedOn);
  const askedFor = clean(preview?.askedFor);
  if (basedOn === null && askedFor === null) return null;
  return { basedOn, askedFor };
}

/**
 * The one-line form, for the composer.
 *
 * The parent arrives already resolved to its display name: `basedOn` holds
 * the title as it was at registration, and a direction renamed since would
 * otherwise be described by a name no longer on the rail.
 */
export function provenanceLine(parent: string | null, askedFor: string | null): string | null {
  const origin = parent === null ? null : `Variant of ${parent}`;
  const ask = askedFor === null ? null : `asked for “${askedFor}”`;
  if (origin === null) return ask === null ? null : `You ${ask}`;
  return ask === null ? origin : `${origin} · you ${ask}`;
}
