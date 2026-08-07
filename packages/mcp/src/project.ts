import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which project the tools act on.
 *
 * Every other face of Leglas learns this the same easy way: the CLI runs in
 * the project, so the working directory is the answer. An MCP server is not
 * always so lucky. An Agent Plugins client starts a plugin's server in the
 * plugin's own install directory (Agent Plugins 1.0.0 §7.2.1), which holds a
 * copy of Leglas and never a project anyone is designing. Taken at face value
 * there, the working directory would send `init` into a plugin cache, leave
 * the rail empty, and report all of it as success.
 *
 * So the directory is asked for rather than assumed:
 *
 * 1. `LEGLAS_PROJECT_DIR`, when someone has said outright where to work.
 * 2. The workspace the host declares over MCP roots, which is the project it
 *    has open. The working directory wins when it sits inside one of those
 *    roots, because a host started in `packages/app` means that, not the
 *    repository above it. Several roots and no match takes the first, which
 *    is a guess, and the reason the override above exists.
 * 3. The working directory, which is the right answer for every host that
 *    starts the server in the project, and the reason nothing changes for
 *    `claude mcp add` or a hand-written `.mcp.json`.
 *
 * When none of those name a project, the tools say so. Refusing is the whole
 * point: a wrong directory is worse than no directory, because it writes.
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

/**
 * The part of an MCP server this needs. The SDK's `Server` satisfies it
 * structurally, which keeps the resolution testable without a transport.
 */
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

export const UNRESOLVED_PROJECT =
  "Leglas could not tell which project to work in. This agent host started the " +
  "Leglas MCP server in the plugin's own directory and declares no workspace " +
  "roots, so there is no project here to act on. Set LEGLAS_PROJECT_DIR to the " +
  "project directory, or run the leglas CLI in the project instead.";

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
  // A client that does not expand ${PLUGIN_ROOT} leaves the literal behind; it
  // matches no real directory, so the check simply does not fire.
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
    // A host that advertises roots and then refuses to list them has told us
    // nothing, which leaves the working directory as good a guess as before.
    return [];
  }
}

/**
 * Roots can only be asked for once the client has initialized; asking earlier
 * is a protocol error. A stdio server is connected well before a host gets
 * around to initializing, and the channel starts polling immediately, so this
 * wait is the ordinary path rather than an edge case.
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
