import { stat } from "node:fs/promises";
import { join } from "node:path";

import { classifyDirection } from "@leglas/server";

import type { ClassifyChange } from "./args.js";
import type { PreviewDeps, PreviewResult } from "./run-previews.js";

/**
 * Answer where a direction should live, before it is written.
 *
 * Both answers are successes: the point is to be asked, so an agent about to
 * change dependencies or rewrite a shared file learns the checkout route
 * instead of quietly costing the property that makes flipping instant.
 */
export async function runClassify(
  options: { changes: ClassifyChange[]; json: boolean; cwd: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const declared = await Promise.all(
    options.changes.map(async (change) => ({
      ...change,
      exists: await stat(join(options.cwd, change.path)).then(
        () => true,
        () => false,
      ),
    })),
  );

  const placement = classifyDirection({ changes: declared });

  if (options.json) {
    deps.log(
      JSON.stringify({
        ok: true,
        level: placement.level,
        reason: placement.reason,
        steps: placement.steps,
      }),
    );
    return { exitCode: 0 };
  }

  deps.log(`  ${placement.level}`);
  deps.log(`  ${placement.reason}`);
  deps.log("");
  placement.steps.forEach((step, index) => deps.log(`  ${index + 1}. ${step}`));
  return { exitCode: 0 };
}
