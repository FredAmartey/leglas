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
  /** The direction this preview is a shade of; the rail groups the family. */
  basedOn?: string | undefined;
};

export type ConfigPayload = {
  /** Stable project identity, so layout survives a port change. */
  project: string;
  devServer: string;
  previews: Preview[];
  errors: string[];
};
