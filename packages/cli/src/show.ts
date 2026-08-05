import { targetFor, type PendingRequest, type Preview } from "@leglas/server";

/**
 * Everything Leglas holds about one direction, assembled for whoever was
 * handed its reference block.
 *
 * The block is copied out of the rail and pasted somewhere else: a chat, an
 * issue, an agent's prompt. It carries enough to read, and points here for the
 * rest. What "the rest" means is deliberate:
 *
 * - the file behind the direction, which nothing else exposes. A URL like
 *   `/?v-hero=aurora` is the scaffold's convention for
 *   `.leglas/variants/hero/aurora.tsx`, and an agent that has to guess at that
 *   goes looking through the tree instead of opening the file.
 * - the set it is being judged against. A direction described alone invites an
 *   agent to improve it straight out of the comparison, which is the one thing
 *   the product exists to prevent.
 * - what is pending against it. Note the tense: requests are a queue that gets
 *   drained and cleared, so this is what has been asked and not yet done, not
 *   a history of everything ever asked.
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
      requests: { intent: string; target: string | null; prompt: string }[];
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
    // A file preview names its own source. Everything else is decoded from the
    // URL, and a URL outside the convention yields nothing rather than a path
    // that looks authoritative and is not there.
    target: preview.file ?? targetFor(preview.url),
  };
}

export function planShow({ title, previews, requests }: ShowInput): ShowPlan {
  const found = previews.find((preview) => preview.title === title);
  if (!found) {
    return {
      ok: false,
      error: `No direction called ${JSON.stringify(title)}. Run leglas list to see them.`,
    };
  }

  const variants = previews.filter((preview) => preview.basedOn === title).map(describe);
  const variantTitles = new Set(variants.map((variant) => variant.title));

  return {
    ok: true,
    direction: describe(found),
    variants,
    // Its own variants are already listed in full, so they are not repeated
    // here; this is the rest of the comparison.
    comparedWith: previews
      .map((preview) => preview.title)
      .filter((other) => other !== title && !variantTitles.has(other)),
    requests: requests
      .filter((request) => request.title === title)
      .map((request) => ({
        intent: request.intent,
        target: request.target,
        prompt: request.prompt,
      })),
  };
}
