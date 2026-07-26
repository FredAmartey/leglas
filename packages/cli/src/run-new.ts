import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { planNew } from "./new.js";

export type NewDeps = { log(line: string): void };

export type NewResult = { exitCode: number; written: string[] };

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Scaffold a branch point for a surface.
 *
 * Writes only into the gitignored directory and, at most, appends one line to
 * .gitignore. The single change to the user's own source is printed rather
 * than applied: rewriting somebody's component automatically is how a tool
 * breaks a codebase it does not understand, and a wrong edit there costs far
 * more than a line of copying.
 */
export async function runNew(
  options: { surface: string; print: boolean; cwd: string },
  deps: NewDeps,
): Promise<NewResult> {
  const plan = planNew({
    surface: options.surface,
    packageJson: await readIfPresent(join(options.cwd, "package.json")),
    gitignore: await readIfPresent(join(options.cwd, ".gitignore")),
  });

  if (plan.writes.length === 0) {
    deps.log(`Nothing to scaffold for ${JSON.stringify(options.surface)}.`);
    return { exitCode: 1, written: [] };
  }

  if (options.print) {
    for (const write of plan.writes) {
      deps.log(`--- ${write.path}`);
      deps.log(write.contents);
    }
    deps.log(plan.instructions);
    return { exitCode: 0, written: [] };
  }

  const existing = plan.writes.filter((write) => existsSync(join(options.cwd, write.path)));
  if (existing.length > 0) {
    deps.log(`${existing[0]?.path} already exists. Delete it first, or pick another surface name.`);
    return { exitCode: 1, written: [] };
  }

  const written: string[] = [];
  for (const write of plan.writes) {
    const target = join(options.cwd, write.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.contents, "utf8");
    written.push(write.path);
  }

  if (plan.gitignore !== null) {
    await writeFile(join(options.cwd, ".gitignore"), plan.gitignore, "utf8");
    written.push(".gitignore");
  }

  for (const path of written) deps.log(`  created  ${path}`);
  deps.log("");
  deps.log(plan.instructions);
  deps.log("Then add these to leglas.config.ts:");
  deps.log("");
  for (const preview of plan.previews) {
    deps.log(`  { title: ${JSON.stringify(preview.title)}, url: ${JSON.stringify(preview.url)} },`);
  }

  return { exitCode: 0, written };
}
