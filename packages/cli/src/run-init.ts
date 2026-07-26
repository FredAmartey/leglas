import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { findConfigFile } from "@leglas/server";

import { planInit } from "./init.js";

export type InitDeps = { log(line: string): void };

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Prepare a project: an AGENTS.md section so any agent entering the repo knows
 * how to author directions, a starter config, and the ignore entry. Adopting
 * Leglas in a repository is what distributes the contract; nothing has to be
 * installed per user.
 */
export async function runInit(
  options: { cwd: string; force: boolean; json: boolean },
  deps: InitDeps,
): Promise<{ exitCode: number }> {
  const existingConfig = findConfigFile(options.cwd);

  const plan = planInit({
    agents: await readIfPresent(join(options.cwd, "AGENTS.md")),
    config: existingConfig === null ? null : "present",
    gitignore: await readIfPresent(join(options.cwd, ".gitignore")),
    force: options.force,
  });

  const touched: string[] = [];
  for (const write of plan.writes) {
    await writeFile(join(options.cwd, write.path), write.contents, "utf8");
    touched.push(write.path);
  }
  if (plan.gitignore !== null) {
    await writeFile(join(options.cwd, ".gitignore"), plan.gitignore, "utf8");
    touched.push(".gitignore");
  }

  if (options.json) {
    deps.log(JSON.stringify({ ok: true, written: touched }));
    return { exitCode: 0 };
  }

  if (touched.length === 0) {
    deps.log("Already set up. Nothing to change.");
    return { exitCode: 0 };
  }

  for (const path of touched) deps.log(`  wrote  ${path}`);
  deps.log("");
  deps.log("Your agents now know how to add design directions to this project.");
  deps.log("Ask one for a few variations of a surface, then run leglas.");
  return { exitCode: 0 };
}
