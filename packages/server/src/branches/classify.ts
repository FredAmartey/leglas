/**
 * Decides where a direction should live before it's written. In-app is the
 * default, since that's what makes flipping instant; a direction gets its own
 * checkout only when it can't share the running server. Rules over what the
 * author declares, with a one-line reason.
 */

export type DeclaredChange = {
  path: string;
  /**
   * "change" is additive: create a file or mount a branch point in one.
   * "rewrite" alters what an existing file renders, which can't coexist with
   * its current behaviour.
   */
  kind: "change" | "rewrite";
  /** Whether the path exists right now. The caller stats; this stays pure. */
  exists: boolean;
};

export type Placement = {
  level: "in-app" | "checkout";
  reason: string;
  steps: string[];
};

/** One of these anywhere in the change set means a different dependency set. */
const MANIFESTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "pnpm-workspace.yaml",
]);

function basename(path: string): string {
  const segments = path.split("/");

  return segments[segments.length - 1] ?? path;
}

function isManifest(path: string): boolean {
  return MANIFESTS.has(basename(path));
}

/**
 * Build and environment config applies to the whole server, so a direction that
 * needs it different can't share it. Leglas's own config is exempt: editing it
 * is registration.
 */
function isBuildConfig(path: string): boolean {
  const name = basename(path);

  if (name.startsWith("leglas.config.")) return false;

  if (/^tsconfig[^/]*\.json$/.test(name)) return true;

  if (name === ".env" || name.startsWith(".env.")) return true;

  if (name === ".babelrc" || name.startsWith(".babelrc.")) return true;

  if (name === "turbo.json") return true;

  return /\.config\.[a-z]+$/i.test(name);
}

/** Files under .leglas/ belong to the direction that declared them. */
function isExplorationFile(path: string): boolean {
  return path.startsWith(".leglas/") || path.includes("/.leglas/");
}

const CHECKOUT_STEPS = [
  "Build the direction on its own branch: git switch -c <branch>, commit it there, switch back.",
  'Register it: npx leglas add --title "<title>" --url "/" --branch <branch>.',
  "Make sure the config sets devCommand (with {port}), so Leglas can start the checkout.",
];

const IN_APP_STEPS = [
  "Author it additively under .leglas/variants/<surface>/, beside the existing directions.",
  'Register it: npx leglas add --title "<title>" --url "/?v-<surface>=<direction>".',
];

export function classifyDirection(input: { changes: readonly DeclaredChange[] }): Placement {
  const checkout = (reason: string): Placement => ({
    level: "checkout",
    reason,
    steps: CHECKOUT_STEPS,
  });

  const manifest = input.changes.find((change) => isManifest(change.path));

  if (manifest !== undefined) {
    return checkout(
      `${manifest.path} changes the dependency set, and one running server cannot hold two.`,
    );
  }

  const config = input.changes.find((change) => isBuildConfig(change.path));

  if (config !== undefined) {
    return checkout(
      `${config.path} is build configuration, which applies to every direction in the one server.`,
    );
  }

  // A rewrite of a missing path is a creation, and a rewrite of the direction's
  // own exploration files contends with nobody.
  const rewrite = input.changes.find(
    (change) => change.kind === "rewrite" && change.exists && !isExplorationFile(change.path),
  );

  if (rewrite !== undefined) {
    return checkout(
      `${rewrite.path} already renders for the other directions; rewriting it makes them contend for one file.`,
    );
  }

  return {
    level: "in-app",
    reason: "Everything declared adds beside what exists, so it renders from the running server.",
    steps: IN_APP_STEPS,
  };
}
