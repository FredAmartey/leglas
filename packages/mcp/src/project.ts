import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which project the tools act on.
 *
 * An Agent Plugins client starts the server in the plugin's install directory
 * (Agent Plugins 1.0.0 §7.2.1), so the working directory can't be trusted. In
 * order:
 *
 * 1. `LEGLAS_PROJECT_DIR`.
 * 2. The host's MCP roots. The working directory wins when it sits inside one,
 *    since a host started in `packages/app` means that; with several roots and
 *    no match, the first.
 * 3. The working directory, which covers `claude mcp add` and a hand-written
 *    `.mcp.json`.
 *
 * With none of those the tools refuse: a wrong directory is worse than none,
 * because it writes.
 */

export type Located = { ok: true; directory: string } | { ok: false; reason: string };

export type Project = {
  /**
   * The project directory, resolved once and held for the life of the process.
   * A viewer, a request queue, and a channel all bind to one project, so a
   * session that changed its mind halfway would already have a server running
   * against the old one.
   */
  locate(): Promise<Located>;
};

/** A project fixed to one directory: what an embedder or a test already knows. */
export function fixedProject(directory: string): Project {
  const located: Located = { ok: true, directory };

  return { locate: async () => located };
}

/** The part of the SDK's `Server` this needs, so it tests without a transport. */
export type RootsHost = {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(): Promise<{ roots: { uri: string }[] }>;
  oninitialized?: (() => void) | undefined;
};

export type HostProjectOptions = {
  /** The process working directory. */
  cwd: string;
  /** `LEGLAS_PROJECT_DIR`: an explicit answer that ends the search. */
  override?: string | undefined;
  /**
   * `LEGLAS_PLUGIN_ROOT`: where an Agent Plugins client installed us, which
   * the plugin's own `mcp.json` passes as `${PLUGIN_ROOT}`. Its only use is
   * recognising a working directory that means nothing.
   */
  pluginRoot?: string | undefined;
};

/** Covers no roots, an empty workspace and a failed answer alike. */
export const UNRESOLVED_PROJECT =
  "Leglas could not tell which project to work in. This agent host started the " +
  "Leglas MCP server in the plugin's own directory and named no workspace to " +
  "work in, so there is no project here to act on. Set LEGLAS_PROJECT_DIR to " +
  "the project directory, or run the leglas CLI in the project instead.";

export function hostProject(host: RootsHost, options: HostProjectOptions): Project {
  let pending: Promise<Located> | null = null;

  return { locate: () => (pending ??= discover(host, options)) };
}

async function discover(host: RootsHost, options: HostProjectOptions): Promise<Located> {
  const override = options.override?.trim();

  if (override !== undefined && override !== "") {
    return { ok: true, directory: resolve(override) };
  }

  const cwd = canonical(options.cwd);
  const roots = await declaredRoots(host);

  if (roots.some((root) => contains(canonical(root), cwd))) {
    return { ok: true, directory: options.cwd };
  }

  const first = roots[0];

  if (first !== undefined) return { ok: true, directory: first };

  const pluginRoot = options.pluginRoot?.trim();

  // An unexpanded ${PLUGIN_ROOT} matches no real directory, so the check just
  // doesn't fire.
  if (pluginRoot !== undefined && pluginRoot !== "" && contains(canonical(pluginRoot), cwd)) {
    return { ok: false, reason: UNRESOLVED_PROJECT };
  }

  return { ok: true, directory: options.cwd };
}

async function declaredRoots(host: RootsHost): Promise<string[]> {
  await initialized(host);

  if (host.getClientCapabilities()?.roots === undefined) return [];

  try {
    const { roots } = await host.listRoots();

    return roots
      .map((root) => toDirectory(root.uri))
      .filter((directory): directory is string => directory !== null);
  } catch {
    // Roots advertised but not listed: the working directory is as good a guess
    // as before.
    return [];
  }
}

/**
 * Roots can't be asked for before the client initializes. A stdio server
 * connects well before that and the channel polls at once, so this wait is the
 * normal path.
 */
function initialized(host: RootsHost): Promise<void> {
  if (host.getClientCapabilities() !== undefined) return Promise.resolve();

  return new Promise((ready) => {
    const previous = host.oninitialized;
    host.oninitialized = () => {
      previous?.();
      ready();
    };
  });
}

/** Roots are file URIs by the spec; a host that sends a bare path still reads. */
function toDirectory(uri: string): string | null {
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }

  return isAbsolute(uri) ? uri : null;
}

function contains(parent: string, child: string): boolean {
  if (child === parent) return true;

  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Compared paths are real paths: /tmp is a symlink on macOS, among others. */
function canonical(directory: string): string {
  const absolute = resolve(directory);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
