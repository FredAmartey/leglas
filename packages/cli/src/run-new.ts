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
  options: { surface: string; print: boolean; json: boolean; from?: string | undefined; cwd: string },
  deps: NewDeps,
): Promise<NewResult> {
  let from: { path: string; contents: string } | undefined;
  if (options.from !== undefined) {
    const contents = await readIfPresent(join(options.cwd, options.from));
    if (contents === null) {
      const message = `${options.from} does not exist, so there is nothing to use as the baseline.`;
      if (options.json) deps.log(JSON.stringify({ ok: false, error: message }));
      else deps.log(message);
      return { exitCode: 1, written: [] };
    }
    from = { path: options.from, contents };
  }

  const plan = planNew({
    surface: options.surface,
    packageJson: await readIfPresent(join(options.cwd, "package.json")),
    gitignore: await readIfPresent(join(options.cwd, ".gitignore")),
    from,
  });

  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.log(error);
    return { exitCode: 1, written: [] };
  };

  if (plan.writes.length === 0) {
    return fail(`Nothing to scaffold for ${JSON.stringify(options.surface)}.`);
  }

  if (options.print) {
    if (options.json) {
      deps.log(JSON.stringify({ ok: true, files: plan.writes, instructions: plan.instructions, previews: plan.previews }));
      return { exitCode: 0, written: [] };
    }
    for (const write of plan.writes) {
      deps.log(`--- ${write.path}`);
      deps.log(write.contents);
    }
    deps.log(plan.instructions);
    return { exitCode: 0, written: [] };
  }

  const existing = plan.writes.filter((write) => existsSync(join(options.cwd, write.path)));
  if (existing.length > 0) {
    return fail(`${existing[0]?.path} already exists. Delete it first, or pick another surface name.`);
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

  if (options.json) {
    deps.log(
      JSON.stringify({ ok: true, written, instructions: plan.instructions, previews: plan.previews }),
    );
    return { exitCode: 0, written };
  }

  for (const path of written) deps.log(`  created  ${path}`);
  deps.log("");
  deps.log(plan.instructions);
  deps.log("Then register them so they appear in the interface:");
  deps.log("");
  for (const preview of plan.previews) {
    deps.log(`  npx leglas add --title ${JSON.stringify(preview.title)} --url ${JSON.stringify(preview.url)}`);
  }

  return { exitCode: 0, written };
}
