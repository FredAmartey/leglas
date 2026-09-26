import { planExplore } from "./explore.js";

export type ExploreDeps = { log(line: string): void };

/**
 * Briefs an agent's exploration. Leglas runs no model and hands out no taste;
 * this prints only what the agent can't know: how a set registers here, what
 * it's for and how sets fail.
 */
export function runExplore(
  options: { surface: string; count: number; basedOn: string | null; json: boolean },
  deps: ExploreDeps,
) {
  if (!Number.isFinite(options.count) || options.count <= 0) {
    deps.log(
      options.json
        ? JSON.stringify({ ok: false, error: "Ask for at least one direction." })
        : "Ask for at least one direction, for example --count 4.",
    );

    return { exitCode: 1 };
  }

  const plan = planExplore(options.surface, Math.floor(options.count), options.basedOn);

  if (options.json) {
    deps.log(JSON.stringify({ ok: true, ...plan }));

    return { exitCode: 0 };
  }

  deps.log(plan.instructions);

  return { exitCode: 0 };
}
