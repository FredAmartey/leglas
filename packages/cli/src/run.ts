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
  type UpdateService,
} from "@leglas/server";

import type { RunOptions } from "./args.js";
import { devServerOwnerWarning, inspectLocalDevServer } from "./dev-server-owner.js";

/**
 * The built interface: bundled beside this file at dist/shell/ in the published
 * package, else resolved through the workspace. Missing is survivable; the
 * server shows a placeholder.
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
 * The embedded agent is a child of this CLI process, so registration can call
 * the running package directly. The fallback covers source imports and
 * programmatic hosts with no bin file.
 */
function embeddedLeglasCommand(): string {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "bin.js");

  if (!existsSync(entry)) return "npx -y leglas";

  return [process.execPath, entry].map(shellWord).join(" ");
}

export type RunDeps = {
  open(url: string): Promise<void>;
  log(line: string): void;
  /** The CLI supplies updates; programmatic hosts can omit them. */
  updates?: UpdateService;
};

/** Automated runs and an explicit opt-out should never ask npm at startup. */
export function skipStartupCheck(env: NodeJS.ProcessEnv): boolean {
  const off = (value: string | undefined): boolean =>
    value === undefined || value === "" || value === "0" || value === "false";

  // CI follows ci-info: only the literal false opts out of a nonempty CI value.
  return (
    (env.CI !== undefined && env.CI !== "" && env.CI !== "false") ||
    !off(env.LEGLAS_NO_UPDATE_CHECK)
  );
}

export type RunResult = {
  exitCode: number;
  /** Where the interface lives, which is what gets opened and reported. */
  url: string;
  devServer: string;
  previewCount: number;
  stop(): Promise<void>;
};

/**
 * Boots Leglas: resolve config, start the server, open the interface. Only
 * failing to bind a port is fatal; a missing or invalid config or a stopped dev
 * server is reported, since the user is mid-setup.
 */
export async function run(
  options: RunOptions & { cwd: string },
  deps: RunDeps,
): Promise<RunResult> {
  return runWithServices(options, deps);
}

/** Boot using the host's config, server and process inspection services. */
export async function runWithServices(
  options: RunOptions & { cwd: string },
  deps: RunDeps,
  services: {
    loadConfig?: typeof loadConfig;
    readLocalPreviews?: typeof readLocalPreviews;
    startServer?: typeof startServer;
    inspectLocalDevServer?: typeof inspectLocalDevServer;
  } = {},
): Promise<RunResult> {
  const loaded = await (services.loadConfig ?? loadConfig)(options.cwd);
  const local = await (services.readLocalPreviews ?? readLocalPreviews)(options.cwd);

  let devServer =
    options.userPort === undefined
      ? (loaded.config?.devServer ?? "http://localhost:3000")
      : `http://localhost:${options.userPort}`;

  // Local previews go after the shared ones, keeping the committed order.
  const merged =
    loaded.config === null
      ? null
      : { ...loaded.config, devServer, previews: [...loaded.config.previews, ...local.previews] };

  const previewErrors: string[] = [];
  const previews: Preview[] = [];

  // Nothing is listening but the config says how to start the app, so Leglas
  // starts it like a checkout. Not behind --user-port, which names a server
  // explicitly.
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

  // File previews are resolved before the server starts, because their
  // directories become mounts on the Leglas origin. Branch previews keep their
  // authored path until the server's worktree is ready.
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

  const projectRoot = await realpath(
    loaded.path === null ? options.cwd : dirname(loaded.path),
  ).catch(() => resolve(loaded.path === null ? options.cwd : dirname(loaded.path)));

  const ownerWarning =
    needsApp && app === null
      ? (services.inspectLocalDevServer ?? inspectLocalDevServer)(devServer)
          .then((owners) => devServerOwnerWarning(devServer, projectRoot, owners))
          .catch(() => null)
      : Promise.resolve(null);

  const serverOptions: Parameters<typeof startServer>[0] = {
    config,
    configErrors: [...loaded.errors, ...local.errors, ...previewErrors],
    configWarnings,
    fileMounts,
    shellDir: findShellDir(),
    // The config file identifies the project, else the directory, so saved
    // layout survives a port change.
    project: loaded.path ?? options.cwd,
    cwd: options.cwd,
    leglasCommand: embeddedLeglasCommand(),
  };

  if (deps.updates !== undefined) serverOptions.updates = deps.updates;

  if (options.port !== undefined) serverOptions.port = options.port;
  const serverPromise = (services.startServer ?? startServer)(serverOptions);

  const [server, warning] = await Promise.all([serverPromise, ownerWarning]);

  if (warning !== null) configWarnings.push(warning);

  const url = `${server.url}${LEGLAS_PREFIX}`;
  const previewCount = config?.previews.length ?? 0;

  // Probing through the server keeps one implementation of "is it up".
  // SAFETY: This health route belongs to the server just started above and returns `reachable`.
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

  let stopped = false;
  let updateTimer: ReturnType<typeof setInterval> | null = null;

  if (!options.json && deps.updates !== undefined && !skipStartupCheck(process.env)) {
    void deps.updates.check().then(() => {
      if (stopped) return;
      const line = deps.updates?.notice();

      if (line !== null && line !== undefined) deps.log(line);
    });
    const updates = deps.updates;
    updateTimer = setInterval(() => void updates.check(), 60 * 60_000);
    updateTimer.unref?.();
  }

  return {
    exitCode: 0,
    url,
    devServer,
    previewCount,
    stop: async () => {
      stopped = true;

      if (updateTimer !== null) clearInterval(updateTimer);
      // The server owns branch worktrees; the CLI owns the app it may have
      // started.
      await app?.stop().catch(() => {});
      await server.close();
    },
  };
}
