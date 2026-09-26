export type Preview = {
  /**
   * Unique within a config and the stable key for saved layout. An interface
   * rename changes the label only; editing the title in the config starts its
   * layout afresh, since nothing else identifies it.
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
   * How the direction is backed when it isn't a plain route on the app, so a
   * copied reference can name its source.
   */
  branch?: string | undefined;
  file?: string | undefined;
  /**
   * Where a branch's checkout has got to. Only branch previews carry this, and
   * one that isn't `ready` has no `url`, since framing an address nothing
   * serves would look broken rather than unstarted.
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
   * Present when opened through a share link. The server already cut the
   * previews to what was shared; this carries the sharer's arrangement and
   * marks the interface as someone else's.
   */
  viewer?: ViewerInfo | undefined;
};

/** Which directions a share carries: one, a pair on stage or the rail. */
export type ShareScope = "direction" | "compare" | "rail";

/**
 * The sharer's rail when they shared. A snapshot, not a mirror, so the sharer
 * can keep reordering without moving the viewer's rail, and pushes an update
 * when they mean to.
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

/** How far a viewer may reach into the dev server behind a share. */
export type ShareReach = "open" | "listed";

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
 * One link into a share; a share can hold several, one per person, each cut
 * independently. A link is a capability, not a person: one browser holds one at
 * a time (two entry links on one origin write the same cookie), so `viewers`
 * counts sessions.
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
  reach: ShareReach;
  /** Paths a viewer may load in `listed` reach. A trailing slash is a directory. */
  routes: string[];
  /** What `listed` turned away, newest last, for the panel to offer. */
  refused: string[];
  sharePort: number;
  grants: ShareGrant[];
  tunnel: TunnelState;
  startedAt: number;
};

/** How the running Leglas got onto this machine, which decides how it updates. */
export type InstallKind = "npx" | "global" | "project" | "source";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Install = {
  kind: InstallKind;
  manager: PackageManager;
  /** What a person would type to bring in the newest version. Null for a checkout. */
  command: string | null;
  /** Where a project command runs. Project kind only. */
  root?: string | undefined;
};

export type Release = {
  version: string;
  /** The release heading's title from the changelog, when the site answered. */
  title: string | null;
  /** The changelog entry for it. */
  url: string;
};

/**
 * Where an update has got to. The server owns this and nudges on every change;
 * the interface also reads it every second while waiting for a restarted
 * Leglas, and reloads once that answers.
 */
export type UpdatePhase =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "installing"; version: string }
  /** Installed, and holding the restart until the running change finishes. */
  | { status: "waiting"; version: string }
  | { status: "restarting"; version: string }
  | { status: "failed"; version: string; reason: string };

export type UpdateStatus = {
  /** The version running now. */
  version: string;
  install: Install;
  /** The newest release known, from the cache or the last check. Null until a check has worked. */
  latest: Release | null;
  /** ISO time of the last check that worked. */
  checkedAt: string | null;
  /** Why the last check said nothing. Null when it worked or has not run. */
  checkError: string | null;
  /** A version the person chose to skip. Cleared when a newer one appears. */
  skipped: string | null;
  /** latest is newer than version, whether or not it was skipped. */
  available: boolean;
  phase: UpdatePhase;
  /** A change is running in the embedded agent; installing now would kill it. */
  busy: boolean;
};
