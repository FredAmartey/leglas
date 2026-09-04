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
  /**
   * Present when this interface was opened through a share link. The server
   * has already cut the previews down to what was shared; this carries how
   * the sharer had them arranged, and says the interface is somebody else's.
   */
  viewer?: ViewerInfo | undefined;
};

/** Which directions a share carries: one, a pair on stage or the rail. */
export type ShareScope = "direction" | "compare" | "rail";

/**
 * The rail as the sharer sees it, at the moment they shared. Snapshot rather
 * than mirror: the sharer can keep reordering for themselves without the
 * viewer's rail moving underneath them, and pushes an update when they mean
 * to.
 */
export type ShareLayout = {
  order: string[];
  renames: Record<string, string>;
  collapsedFamilies: string[];
  /** The right pane when the scope is compare; null otherwise. */
  compare: string | null;
  /** null is Full. */
  viewport: number | null;
};

export type ViewerInfo = {
  scope: ShareScope;
  layout: ShareLayout;
};

export type TunnelProviderId = "cloudflared" | "ngrok";

export type TunnelState =
  | { status: "none" }
  | {
      status: "starting";
      provider: TunnelProviderId;
      url?: string | undefined;
      /** Not answering from here yet, past the time it usually takes. */
      slow?: boolean | undefined;
    }
  | { status: "ready"; provider: TunnelProviderId; url: string }
  | { status: "failed"; provider: TunnelProviderId; reason: string; url?: string | undefined };

/**
 * One link into a share. A share can hold several, so a sharer can send one
 * per person and cut one without disturbing the rest.
 *
 * A link is a capability, not a person: one browser holds one at a time,
 * because two entry links on the same origin write the same cookie. So the
 * count below is sessions on this link, and the interface says so.
 */
export type ShareGrant = {
  id: string;
  /** Whatever the sharer typed, or empty until they name it. */
  name: string;
  /** Public entry link once a tunnel has a URL, else null. */
  url: string | null;
  /** Entry link on the share listener, for a tunnel the user runs themselves. */
  localUrl: string;
  viewers: number;
  createdAt: number;
  /** When it stops working, absolute, unless the sharer extends it. */
  expiresAt: number;
};

export type ShareStatus = {
  id: string;
  scope: ShareScope;
  titles: string[];
  layout: ShareLayout;
  sharePort: number;
  grants: ShareGrant[];
  tunnel: TunnelState;
  startedAt: number;
};
