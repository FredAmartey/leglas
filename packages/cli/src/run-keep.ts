import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  DEFAULT_LOG_DIR,
  composeEntry,
  dropLocalPreviews,
  loadConfig,
  readAnnotations,
  readLocalPreviews,
  readRenames,
  readRequests,
} from "@leglas/server";

import { planKeep } from "./keep.js";
import { resolveOrExplain } from "./resolve-title.js";

export type KeepDeps = { log(line: string): void; error(line: string): void };

/**
 * Renames the winner's export after the surface. Only the leading export
 * declaration, which the scaffold generates, is rewritten; other uses of the
 * old name are left alone.
 */
function renameExport(source: string, to: string): string {
  const match = /export function ([A-Za-z0-9_]+)\s*\(/.exec(source);

  if (!match || match[1] === undefined) return source;

  return source.replace(new RegExp(`\\b${match[1]}\\b`, "g"), to);
}

/**
 * Writes down the exploration before it's deleted, since the directions, their
 * requests and the captures are the record. Returns where it was written, or
 * null if there was nothing to say. Never fatal: the winner is already in
 * source.
 */
async function writeLogEntry(options: {
  cwd: string;
  logDir: string;
  surface: string;
  won: { title: string; to: string };
  previews: readonly Parameters<typeof composeEntry>[0]["previews"][number][];
}): Promise<string | null> {
  const entry = composeEntry({
    surface: options.surface,
    won: options.won,
    previews: options.previews,
    requests: await readRequests(options.cwd),
    annotations: await readAnnotations(options.cwd),
    date: new Date().toISOString().slice(0, 10),
  });

  const dir = join(options.cwd, options.logDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${entry.slug}.md`);
  await writeFile(file, entry.markdown, "utf8");

  if (entry.pictures.length > 0) {
    const pictureDir = join(dir, entry.slug);
    await mkdir(pictureDir, { recursive: true });

    for (const picture of entry.pictures) {
      // A capture that has already been pruned is skipped rather than fatal.
      await copyFile(join(options.cwd, picture.from), join(pictureDir, picture.to)).catch(() => {});
    }
  }

  return `${options.logDir}/${entry.slug}.md`;
}

export async function runKeep(
  options: { title: string; to: string; json: boolean; cwd: string },
  deps: KeepDeps,
): Promise<{ exitCode: number }> {
  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const previews = [...(loaded.config?.previews ?? []), ...local.previews];

  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  // Keeping moves a file and deletes the rest, so the name must resolve to
  // exactly one direction; a local rename matching two is refused.
  const resolved = resolveOrExplain(
    options.title,
    previews.map((preview) => preview.title),
    await readRenames(options.cwd),
  );

  if (!resolved.ok) return fail(resolved.error);

  // Agents tend to pass absolute paths. One outside the project comes out as
  // `..` or still absolute, and planKeep refuses both.
  const destination = isAbsolute(options.to) ? relative(options.cwd, options.to) : options.to;
  const plan = planKeep({ title: resolved.title, previews, to: destination });

  if (!plan.ok) return fail(plan.error);

  const from = join(options.cwd, plan.move.from);
  const to = join(options.cwd, plan.move.to);

  if (!existsSync(from)) {
    return fail(`${plan.move.from} does not exist. Nothing to keep.`);
  }

  if (existsSync(to)) {
    return fail(`${plan.move.to} already exists. Choose another destination or move it aside.`);
  }

  const source = await readFile(from, "utf8");
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, renameExport(source, plan.exportName), "utf8");

  // Written before the exploration is cleared, since the record is made of
  // what's being cleared.
  const surface = plan.removeDir.slice(plan.removeDir.lastIndexOf("/") + 1);
  let logged: string | null = null;
  let logError: string | null = null;

  try {
    logged = await writeLogEntry({
      cwd: options.cwd,
      logDir: loaded.config?.logDir ?? DEFAULT_LOG_DIR,
      surface,
      won: { title: resolved.title, to: plan.move.to },
      previews: previews.filter((preview) => plan.dropTitles.includes(preview.title)),
    });
  } catch (error) {
    logError = error instanceof Error ? error.message : String(error);
  }

  // The exploration goes only after the winner is safely written.
  await rm(join(options.cwd, plan.removeDir), { recursive: true, force: true });
  const dropped = await dropLocalPreviews(options.cwd, plan.dropTitles);

  if (options.json) {
    deps.log(
      JSON.stringify({
        ok: true,
        kept: resolved.title,
        to: plan.move.to,
        exportName: plan.exportName,
        removed: plan.removeDir,
        droppedPreviews: dropped,
        logged,
        logError,
        instructions: plan.instructions,
      }),
    );

    return { exitCode: 0 };
  }

  deps.log(`  kept     ${plan.move.to}`);
  deps.log(`  removed  ${plan.removeDir}`);

  if (logged !== null) deps.log(`  logged   ${logged}`);

  if (logError !== null) deps.error(`  The decision log could not be written: ${logError}`);

  if (dropped > 0) {
    deps.log(`  dropped  ${dropped} direction${dropped === 1 ? "" : "s"} from the rail`);
  }

  const stillShared = plan.dropTitles.filter(
    (title) => !local.previews.some((preview) => preview.title === title),
  );

  if (stillShared.length > 0) {
    deps.log("");
    deps.log(`  Remove these from leglas.config.ts by hand: ${stillShared.join(", ")}`);
  }

  deps.log("");
  deps.log(plan.instructions);

  return { exitCode: 0 };
}
