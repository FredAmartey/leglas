import { createRequire } from "node:module";
import { dirname, relative } from "node:path";

import { LEGLAS_PREFIX, loadConfig, readLocalPreviews, startServer } from "@leglas/server";

import type { RunOptions } from "./args.js";

/**
 * Locate the built interface. Resolved through the package graph rather than
 * a relative path, so it works the same from the workspace and from an
 * installed copy. A missing build is survivable: the server falls back to a
 * placeholder rather than refusing to start.
 */
function findShellDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("@leglas/shell/dist/index.html"));
  } catch {
    return null;
  }
}

export type RunDeps = {
  open(url: string): Promise<void>;
  log(line: string): void;
};

export type RunResult = {
  exitCode: number;
  /** Where the interface lives, which is what gets opened and reported. */
  url: string;
  devServer: string;
  previewCount: number;
  stop(): Promise<void>;
};

/**
 * Boot Leglas: resolve config, start the server, open the interface.
 *
 * Nothing here is fatal except being unable to bind a port. A missing config,
 * an invalid config, or a dev server that is not running are all reported and
 * survivable, because the user is mid-setup and needs to be told what to fix,
 * not handed a stack trace.
 */
export async function run(
  options: RunOptions & { cwd: string },
  deps: RunDeps,
): Promise<RunResult> {
  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);

  const devServer =
    options.userPort === undefined
      ? loaded.config?.devServer ?? "http://localhost:3000"
      : `http://localhost:${options.userPort}`;

  // Locally added previews append after the shared ones, so the committed
  // config keeps its authored order and exploration accumulates below it.
  const config =
    loaded.config === null
      ? null
      : { ...loaded.config, devServer, previews: [...loaded.config.previews, ...local.previews] };

  const server = await startServer({
    config,
    configErrors: [...loaded.errors, ...local.errors],
    shellDir: findShellDir(),
    // The config file identifies the project when there is one; otherwise the
    // directory does. Either way saved layout survives a port change.
    project: loaded.path ?? options.cwd,
    cwd: options.cwd,
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  const url = `${server.url}${LEGLAS_PREFIX}`;
  const previewCount = config?.previews.length ?? 0;

  // Probing through the server keeps one implementation of "is it up".
  const health = (await (await fetch(`${server.url}${LEGLAS_PREFIX}/api/health`)).json()) as {
    reachable: boolean;
  };

  if (options.json) {
    deps.log(
      JSON.stringify({
        ok: true,
        url,
        port: server.port,
        devServer,
        devServerReachable: health.reachable,
        previews: previewCount,
        config: loaded.path,
        errors: loaded.errors,
      }),
    );
  } else {
    const configLabel =
      loaded.path === null
        ? "no config file, previewing the app root"
        : relative(options.cwd, loaded.path) || loaded.path;

    deps.log(`Leglas   ${url}`);
    deps.log(`app      ${devServer}${health.reachable ? "" : "  (not reachable)"}`);
    deps.log(`config   ${configLabel}`);
    deps.log(`          ${previewCount} preview${previewCount === 1 ? "" : "s"}`);

    if (loaded.errors.length > 0) {
      deps.log("");
      for (const error of loaded.errors) deps.log(`  ! ${error}`);
      deps.log("  Fix the config and reload; Leglas will pick it up on restart.");
    }

    if (!health.reachable) {
      deps.log("");
      deps.log(`  ! ${devServer} is not reachable. Start your dev server, or`);
      deps.log("    point Leglas elsewhere with --user-port.");
    }
  }

  if (options.open) await deps.open(url);

  return {
    exitCode: 0,
    url,
    devServer,
    previewCount,
    stop: () => server.close(),
  };
}
