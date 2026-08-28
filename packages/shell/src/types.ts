export type Preview = {
  /**
   * Unique within a config, and the stable key for saved layout. Renaming in
   * the interface changes the label only; editing the title in the config
   * starts that preview's layout afresh, which is the honest behaviour since
   * nothing else identifies it.
   */
  title: string;
  url: string;
  note?: string | undefined;
  tags: readonly string[];
  /** The direction this preview is a variant of; the rail groups the family. */
  basedOn?: string | undefined;
  /** The change that was asked for, in the words that were typed. */
  askedFor?: string | undefined;
  /** Added through `leglas add`, so Leglas can remove its local registration. */
  local?: boolean | undefined;
  /**
   * How the direction is backed, when it is not just a route on the running
   * app. The server has always sent these; the interface reads them so a
   * copied reference can name a direction's source rather than only its URL,
   * which is the part an agent can act on.
   */
  branch?: string | undefined;
  file?: string | undefined;
  /**
   * Where a branch's checkout has got to. Only branch-backed previews carry
   * this, and one that is not `ready` has no `url`: the checkout it would
   * point at does not exist yet, and framing an address nothing serves is how
   * a preview lies about being broken rather than about being unstarted.
   */
  state?: BranchPreviewState | undefined;
};

/** Coarse enough to say in a sentence, which is all the interface does with it. */
export type BranchPhase = "checking out" | "installing" | "starting";

export type BranchPreviewState =
  | { status: "idle" }
  | { status: "starting"; phase: BranchPhase }
  | { status: "ready" }
  | { status: "failed"; reason: string };

export type ConfigPayload = {
  /** Stable project identity, so layout survives a port change. */
  project: string;
  devServer: string;
  scanPreviews?: boolean;
  previews: Preview[];
  errors: string[];
  warnings?: string[];
};
