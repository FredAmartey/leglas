import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { dropLocalPreviews, loadConfig, readLocalPreviews, readRenames } from "@leglas/server";

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
        instructions: plan.instructions,
      }),
    );
    return { exitCode: 0 };
  }

  deps.log(`  kept     ${plan.move.to}`);
  deps.log(`  removed  ${plan.removeDir}`);
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
