import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 * Rename the winner's export to suit its new home.
 *
 * A direction was written as `AuroraA` or similar because it was one of
 * several; as the surface's only implementation it should be named after the
 * surface. Only the leading export declaration is rewritten, which is what the
 * scaffold generates, and any other occurrence of the old name is left alone
 * rather than blind-replaced.
 */
function renameExport(source: string, to: string): string {
  const match = /export function ([A-Za-z0-9_]+)\s*\(/.exec(source);
  if (!match || match[1] === undefined) return source;
  return source.replace(
    new RegExp(`\\b${match[1]}\\b`, "g"),
    to,
  );
}


/**
 * Write down what this exploration was, before the exploration is deleted.
 *
 * Everything in the entry already existed and was about to go: the directions,
 * the words typed at each of them, the captures the agent was sent. That is
 * correct for the working files and wrong for the record, and the record is
 * what makes coming back to a surface in three months cheaper than starting
 * over.
 *
 * Returns where it was written, or null if there was nothing to say. A failure
 * here is reported by the caller and never fatal: the winner is already in
 * source, and losing the note is not worth losing the move.
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

  // Keeping is the destructive one: it moves a file and deletes the rest of
  // the exploration. So the name has to resolve to exactly one direction, and
  // a local rename that matches two is refused rather than picked between.
  const resolved = resolveOrExplain(
    options.title,
    previews.map((preview) => preview.title),
    await readRenames(options.cwd),
  );
  if (!resolved.ok) return fail(resolved.error);

  const plan = planKeep({ title: resolved.title, previews, to: options.to });

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

  // Written before the exploration is cleared, because the record is made of
  // the things being cleared.
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
