import { targetFor, type PendingRequest, type Preview } from "@leglas/server";

/**
 * Everything Leglas holds about one direction, for whoever was handed its
 * reference block:
 *
 * - the file behind it, which nothing else exposes (`/?v-hero=aurora` is
 *   `.leglas/variants/hero/aurora.tsx` by the scaffold's convention).
 * - the set it's judged against, since a direction described alone gets
 *   improved straight out of the comparison.
 * - what's pending against it: the queue as it stands, not a history.
 */
export type ShowDirection = {
  title: string;
  url: string;
  note: string | null;
  tags: readonly string[];
  basedOn: string | null;
  branch: string | null;
  file: string | null;
  /** Registered on this machine only, rather than in the shared config. */
  local: boolean;
  /** The source file behind it, where the URL follows the scaffold's shape. */
  target: string | null;
};

export type ShowPlan =
  | {
      ok: true;
      direction: ShowDirection;
      /** Directions that name this one as what they are a variant of. */
      variants: ShowDirection[];
      /** Every other direction's title: what this one is up against. */
      comparedWith: string[];
      requests: {
        id: string;
        intent: string;
        target: string | null;
        prompt: string;
        status: PendingRequest["status"];
      }[];
    }
  | { ok: false; error: string };

export type ShowInput = {
  title: string;
  previews: readonly (Preview & { local?: boolean })[];
  requests: readonly PendingRequest[];
};

function describe(preview: Preview & { local?: boolean }): ShowDirection {
  return {
    title: preview.title,
    url: preview.url,
    note: preview.note ?? null,
    tags: preview.tags,
    basedOn: preview.basedOn ?? null,
    branch: preview.branch ?? null,
    file: preview.file ?? null,
    local: preview.local === true,
    // A file preview names its own source; anything else is decoded from the
    // URL, and a URL outside the convention yields nothing rather than a path
    // that isn't there.
    target: preview.file ?? targetFor(preview.url),
  };
}

export function planShow({ title, previews, requests }: ShowInput): ShowPlan {
  const found = previews.find((preview) => preview.title === title);

  if (!found) {
    return {
      ok: false,
      error: `No direction called ${JSON.stringify(title)}. Run npx leglas list to see them.`,
    };
  }

  const variants = previews.filter((preview) => preview.basedOn === title).map(describe);
  const variantTitles = new Set(variants.map((variant) => variant.title));

  return {
    ok: true,
    direction: describe(found),
    variants,
    // Its variants are listed above, so this is the rest of the comparison.
    comparedWith: previews
      .map((preview) => preview.title)
      .filter((other) => other !== title && !variantTitles.has(other)),
    requests: requests
      .filter((request) => request.title === title)
      .map((request) => ({
        id: request.id,
        intent: request.intent,
        target: request.target,
        prompt: request.prompt,
        status: request.status,
      })),
  };
}
