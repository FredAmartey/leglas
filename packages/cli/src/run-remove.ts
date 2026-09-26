import { relative } from "node:path";

import {
  LOCAL_PREVIEWS_PATH,
  dropLocalPreviews,
  loadConfig,
  readLocalPreviews,
  readRenames,
} from "@leglas/server";

import { resolveOrExplain } from "./resolve-title.js";

export type RemoveDeps = { log(line: string): void; error(line: string): void };

/**
 * The rail's delete, from the command line: directions this machine registered
 * leave the registry, and a running rail drops them on its next read. A
 * direction the config lists is the project's, so it is refused, and one
 * refusal removes nothing.
 */
export async function runRemove(
  options: { titles: string[]; json: boolean; cwd: string },
  deps: RemoveDeps,
): Promise<{ exitCode: number }> {
  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);

  // An unreadable registry reads as empty, and every direction in it would seem
  // not to exist.
  if (local.errors.length > 0) {
    return fail(`${LOCAL_PREVIEWS_PATH} has entries Leglas can't read: ${local.errors.join(" ")}`);
  }

  const known = [
    ...new Set(
      [...(loaded.config?.previews ?? []), ...local.previews].map((preview) => preview.title),
    ),
  ];

  const renames = await readRenames(options.cwd);
  const titles: string[] = [];

  for (const asked of options.titles) {
    const resolved = resolveOrExplain(asked, known, renames);

    if (!resolved.ok) return fail(resolved.error);

    if (!titles.includes(resolved.title)) titles.push(resolved.title);
  }

  const registered = new Set(local.previews.map((preview) => preview.title));
  const shared = titles.find((title) => !registered.has(title));

  if (shared !== undefined) {
    const where = loaded.path === null ? "the config" : relative(options.cwd, loaded.path);

    return fail(`${shared} is in ${where}, which the project shares. Remove it there.`);
  }

  await dropLocalPreviews(options.cwd, titles);

  if (options.json) {
    deps.log(JSON.stringify({ ok: true, removed: titles }));
  } else {
    for (const title of titles) deps.log(`  removed  ${title}`);
    deps.log("");
    deps.log(`The files behind ${titles.length === 1 ? "it" : "them"} stay where they are.`);
  }

  return { exitCode: 0 };
}
