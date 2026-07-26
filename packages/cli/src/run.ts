import { relative } from "node:path";

import { LEGLAS_PREFIX, loadConfig, startServer } from "@leglas/server";

import type { RunOptions } from "./args.js";

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

  const devServer =
    options.userPort === undefined
      ? loaded.config?.devServer ?? "http://localhost:3000"
      : `http://localhost:${options.userPort}`;

  const config =
    loaded.config === null ? null : { ...loaded.config, devServer };

  const server = await startServer({
    config,
    configErrors: loaded.errors,
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
