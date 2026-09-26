import { loadConfig, readLocalPreviews, readRenames } from "@leglas/server";

import { resolveOrExplain } from "./resolve-title.js";
import { findLeglas, interfaceUrl } from "./running.js";

export type LinkDeps = {
  log(line: string): void;
  error(line: string): void;
  fetch?: typeof fetch;
};

/**
 * A link for the person to open: the rail, one direction on the stage, or two
 * side by side. Names resolve the way `share` resolves them, so the name the
 * rail shows works too.
 */
export async function runLink(
  options: { titles: string[]; port: number | null; json: boolean; cwd: string },
  deps: LinkDeps,
): Promise<{ exitCode: number }> {
  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const renames = await readRenames(options.cwd);

  const known = [
    ...new Set(
      [...(loaded.config?.previews ?? []), ...local.previews].map((preview) => preview.title),
    ),
  ];

  const titles: string[] = [];

  for (const asked of options.titles) {
    const resolved = resolveOrExplain(asked, known, renames);

    if (!resolved.ok) return fail(resolved.error);
    titles.push(resolved.title);
  }

  const [first, second] = titles;

  if (first !== undefined && first === second) {
    return fail(`Both names are ${first}. Name two different directions to put side by side.`);
  }

  const found = await findLeglas(options.cwd, options.port, deps.fetch ?? fetch);

  if (!found.ok) return fail(found.error);
  const url = interfaceUrl(found.port, titles);

  if (options.json) deps.log(JSON.stringify({ ok: true, url }));
  else deps.log(url);

  return { exitCode: 0 };
}
