import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FILES_PREFIX,
  LEGLAS_PREFIX,
  loadConfig,
  probe,
  readLocalPreviews,
  startAppProcess,
  startServer,
  worktreeSlug,
  type Preview,
  type RunningApp,
} from "@leglas/server";

import type { RunOptions } from "./args.js";
import {
  devServerOwnerWarning,
  inspectLocalDevServer,
} from "./dev-server-owner.js";

/**
 * Locate the built interface. The published package is self-contained, with
 * the shell bundled beside this file at dist/shell/, so that is looked for
 * first; the workspace resolves it through the package graph instead. A
 * missing build is survivable: the server falls back to a placeholder rather
 * than refusing to start.
 */
function findShellDir(): string | null {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "shell");
  if (existsSync(join(bundled, "index.html"))) return bundled;
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("@leglas/shell/dist/index.html"));
  } catch {
    return null;
  }
}

/** A command word safe to paste into the user's platform shell. */
function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:=+\\-]+$/.test(value)) return value;
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The embedded agent is a child of this exact CLI process, so registration
 * can call the already-running package directly. Falling back keeps source
 * imports and unusual programmatic hosts working without pretending a bin
 * file exists beside them.
 */
function embeddedLeglasCommand(): string {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "bin.js");
  if (!existsSync(entry)) return "npx -y leglas";
  return [process.execPath, entry].map(shellWord).join(" ");
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

  let devServer =
    options.userPort === undefined
      ? loaded.config?.devServer ?? "http://localhost:3000"
      : `http://localhost:${options.userPort}`;

  // Locally added previews append after the shared ones, so the committed
  // config keeps its authored order and exploration accumulates below it.
  const merged =
    loaded.config === null
      ? null
      : { ...loaded.config, devServer, previews: [...loaded.config.previews, ...local.previews] };

  const previewErrors: string[] = [];
  const previews: Preview[] = [];

  // The greenfield case, half one: nothing is listening, but the config says
  // how to start the app, so Leglas starts it the way it already starts a
  // checkout. Skipped when --user-port named a server explicitly: starting a
  // different one behind that flag would lie about what is being previewed.
  let app: RunningApp | null = null;
  const needsApp = (merged?.previews ?? []).some(
    (preview) =>
      preview.file === undefined && preview.branch === undefined && preview.url.startsWith("/"),
  );
  if (
    needsApp &&
    merged?.devCommand !== undefined &&
    options.userPort === undefined &&
    !(await probe(devServer))
  ) {
    if (!options.json) deps.log(`  starting your app (${merged.devCommand})…`);
    try {
      app = await startAppProcess({
        cwd: options.cwd,
        devCommand: merged.devCommand,
        label: "your app",
      });
      devServer = app.url;
      merged.devServer = app.url;
    } catch (error) {
      previewErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // File previews are the one preview source the CLI resolves before server
  // startup, because their directories become mounts on the Leglas origin.
  // Branch previews stay registered with their authored path; the server owns
  // their checkout and replaces that path with a worktree URL only once ready.
  const fileMounts = new Map<string, string>();

  for (const preview of merged?.previews ?? []) {
    if (preview.file !== undefined) {
      const absolute = join(options.cwd, preview.file);
      if (!existsSync(absolute)) {
        previewErrors.push(
          `"${preview.title}" names file ${preview.file}, which does not exist. The preview is skipped.`,
        );
        continue;
      }
      let slug = worktreeSlug(preview.title) || "file";
      for (let suffix = 2; fileMounts.has(slug); suffix += 1) {
        slug = `${worktreeSlug(preview.title) || "file"}-${suffix}`;
      }
      fileMounts.set(slug, dirname(absolute));
      previews.push({
        ...preview,
        url: `${FILES_PREFIX}/${slug}/${encodeURIComponent(basename(absolute))}`,
      });
      continue;
    }
    previews.push(preview);
  }

  const config = merged === null ? null : { ...merged, previews };
  const configWarnings: string[] = [];
  const projectRoot = await realpath(loaded.path === null ? options.cwd : dirname(loaded.path)).catch(
    () => resolve(loaded.path === null ? options.cwd : dirname(loaded.path)),
  );
  const ownerWarning =
    needsApp && app === null
      ? inspectLocalDevServer(devServer)
          .then((owners) => devServerOwnerWarning(devServer, projectRoot, owners))
          .catch(() => null)
      : Promise.resolve(null);

  const serverPromise = startServer({
    config,
    configErrors: [...loaded.errors, ...local.errors, ...previewErrors],
    configWarnings,
    fileMounts,
    shellDir: findShellDir(),
    // The config file identifies the project when there is one; otherwise the
    // directory does. Either way saved layout survives a port change.
    project: loaded.path ?? options.cwd,
    cwd: options.cwd,
    leglasCommand: embeddedLeglasCommand(),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  const [server, warning] = await Promise.all([serverPromise, ownerWarning]);
  if (warning !== null) configWarnings.push(warning);

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
        startedApp: app !== null,
        previews: previewCount,
        config: loaded.path,
        errors: loaded.errors,
        warnings: configWarnings,
      }),
    );
  } else {
    const configLabel =
      loaded.path === null
        ? "no config file, previewing the app root"
        : relative(options.cwd, loaded.path) || loaded.path;

    deps.log(`Leglas   ${url}`);
    deps.log(
      `app      ${devServer}${app !== null ? "  (started by Leglas)" : health.reachable ? "" : "  (not reachable)"}`,
    );
    deps.log(`config   ${configLabel}`);
    deps.log(`          ${previewCount} preview${previewCount === 1 ? "" : "s"}`);

    if (loaded.errors.length + previewErrors.length > 0) {
      deps.log("");
      for (const error of [...loaded.errors, ...previewErrors]) deps.log(`  ! ${error}`);
      deps.log("  Fix the config and reload; Leglas will pick it up on restart.");
    }

    if (configWarnings.length > 0) {
      deps.log("");
      for (const warning of configWarnings) deps.log(`  ! ${warning}`);
    }

    if (!health.reachable && needsApp) {
      deps.log("");
      deps.log(`  ! ${devServer} is not reachable. Start your dev server, or`);
      deps.log("    point Leglas elsewhere with --user-port.");
      if (merged?.devCommand === undefined) {
        deps.log("    Set devCommand in the config and Leglas will start it for you.");
      }
    }
  }

  if (options.open) await deps.open(url);

  return {
    exitCode: 0,
    url,
    devServer,
    previewCount,
    stop: async () => {
      // The server owns branch worktrees; the CLI still owns the project app
      // it may have started for the greenfield case.
      await app?.stop().catch(() => {});
      await server.close();
    },
  };
}
