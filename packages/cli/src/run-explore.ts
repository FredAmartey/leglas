import { ALL_BRIEFS, briefsFor, planBriefs } from "./briefs.js";

export type ExploreDeps = { log(line: string): void };

/**
 * Hand an agent several genuinely different angles at once.
 *
 * Leglas runs no model, so orchestration here means divergence pressure rather
 * than inference: the value added over "give me six variants" is that the six
 * are told to disagree, and told which obvious reading would make them
 * converge.
 */
export function runExplore(
  options: { surface: string; count: number; json: boolean },
  deps: ExploreDeps,
): { exitCode: number } {
  const chosen = briefsFor(options.count);

  if (chosen.length === 0) {
    deps.log(
      options.json
        ? JSON.stringify({ ok: false, error: "Ask for at least one direction." })
        : "Ask for at least one direction, for example --count 4.",
    );
    return { exitCode: 1 };
  }

  const plan = planBriefs(options.surface, options.count);

  if (options.json) {
    deps.log(
      JSON.stringify({
        ok: true,
        surface: options.surface,
        directions: chosen,
        previews: plan.previews,
        commands: plan.commands,
        instructions: plan.instructions,
      }),
    );
    return { exitCode: 0 };
  }

  if (options.count > ALL_BRIEFS.length) {
    deps.log(
      `Asked for ${options.count}; there are ${ALL_BRIEFS.length} distinct angles, so ${ALL_BRIEFS.length} follow.`,
    );
    deps.log("");
  }

  for (const brief of chosen) {
    deps.log(`${brief.name}`);
    deps.log(`  ${brief.brief}`);
    deps.log(`  Avoid: ${brief.avoid}`);
    deps.log("");
  }

  deps.log(plan.instructions);
  return { exitCode: 0 };
}
