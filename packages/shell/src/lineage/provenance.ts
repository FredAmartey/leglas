/**
 * Where a direction came from, for the rail's hover and the composer. Composer
 * changes fork, so the rail fills with names nobody chose; which direction it
 * was built from and what was asked for, verbatim, make those rows accountable
 * later. The note says what a direction is; these are what no agent can
 * reconstruct. Kept apart from rendering so the two surfaces never disagree.
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
 * What there is to say about a direction's origin, or null when neither fact is
 * recorded (anything hand-written or older). Null shows nothing, since a card
 * that opens on every row to say nothing teaches people to stop reading it.
 */
export function provenanceOf(preview: ProvenanceSource | null | undefined): Provenance | null {
  const basedOn = clean(preview?.basedOn);
  const askedFor = clean(preview?.askedFor);

  if (basedOn === null && askedFor === null) return null;

  return { basedOn, askedFor };
}

/**
 * The one-line form, for the composer. The parent comes already resolved to its
 * display name, since `basedOn` holds the title from registration and it may
 * have been renamed.
 */
export function provenanceLine(parent: string | null, askedFor: string | null): string | null {
  const origin = parent === null ? null : `Variant of ${parent}`;
  const ask = askedFor === null ? null : `asked for “${askedFor}”`;

  if (origin === null) return ask === null ? null : `You ${ask}`;

  return ask === null ? origin : `${origin} · you ${ask}`;
}
