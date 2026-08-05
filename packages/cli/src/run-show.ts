import { loadConfig, readLocalPreviews, readRenames, readRequests } from "@leglas/server";

import { resolveOrExplain } from "./resolve-title.js";
import { planShow } from "./show.js";

export type ShowDeps = { log(line: string): void; error(line: string): void };

/**
 * Answer for one direction, for whoever was handed its reference block.
 *
 * Addressing is by config title, which is what every other command takes and
 * what the block quotes, so a renamed direction is still reachable by the name
 * the project knows it by.
 */
export async function runShow(
  options: { title: string; json: boolean; cwd: string },
  deps: ShowDeps,
): Promise<{ exitCode: number }> {
  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const requests = await readRequests(options.cwd);

  const previews = [
    ...(loaded.config?.previews ?? []).map((preview) => ({ ...preview, local: false })),
    ...local.previews,
  ];

  // Whoever ran this may be holding the name the rail showed them rather than
  // the one the config spells.
  const resolved = resolveOrExplain(
    options.title,
    previews.map((preview) => preview.title),
    await readRenames(options.cwd),
  );
  if (!resolved.ok) {
    if (options.json) deps.log(JSON.stringify({ ok: false, error: resolved.error }));
    else deps.error(resolved.error);
    return { exitCode: 1 };
  }

  const plan = planShow({ title: resolved.title, previews, requests });

  if (!plan.ok) {
    if (options.json) deps.log(JSON.stringify({ ok: false, error: plan.error }));
    else deps.error(plan.error);
    return { exitCode: 1 };
  }

  if (options.json) {
    deps.log(
      JSON.stringify({
        ok: true,
        direction: plan.direction,
        variants: plan.variants,
        comparedWith: plan.comparedWith,
        requests: plan.requests,
      }),
    );
    return { exitCode: 0 };
  }

  const { direction } = plan;
  deps.log(`  ${direction.title}${direction.local ? "  (local)" : ""}`);
  if (direction.note !== null) deps.log(`  ${direction.note}`);
  deps.log("");
  if (direction.target !== null) deps.log(`  file        ${direction.target}`);
  if (direction.branch !== null) deps.log(`  branch      ${direction.branch}`);
  deps.log(`  url         ${direction.url}`);
  if (direction.tags.length > 0) deps.log(`  tags        ${direction.tags.join(", ")}`);
  if (direction.basedOn !== null) deps.log(`  variant of  ${direction.basedOn}`);
  if (plan.variants.length > 0) {
    deps.log(`  variants    ${plan.variants.map((variant) => variant.title).join(", ")}`);
  }
  if (plan.comparedWith.length > 0) {
    deps.log(`  against     ${plan.comparedWith.join(", ")}`);
  }

  if (plan.requests.length > 0) {
    deps.log("");
    deps.log(`  Pending, not yet done (${plan.requests.length}):`);
    for (const request of plan.requests) deps.log(`    ${request.status}  ${request.intent}`);
    deps.log("");
    deps.log("  Run leglas requests --json for the full prompts.");
  }
  return { exitCode: 0 };
}
