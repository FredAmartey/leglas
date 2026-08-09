import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SNAPSHOT, publicSurface } from "./api-surface.js";

/**
 * The snapshot is the published promise. This is the half that notices when
 * the build stops matching it, which is the moment the change is still cheap:
 * in the pull request that caused it, rather than against a tag, where the
 * only fix is another release.
 *
 * Failing here is not a defect. It means an exported signature moved, and the
 * two things to do about it are to run `pnpm api:update` and then to ask
 * whether the version being planned still describes what consumers will get.
 */
describe("the public API surface", () => {
  test("matches the snapshot", () => {
    const root = import.meta.dirname;
    const recorded = readFileSync(join(root, SNAPSHOT), "utf8");

    expect(
      publicSurface(root),
      `${SNAPSHOT} is out of date. Run \`pnpm api:update\`, read the diff, and if it ` +
        "changes what an importer sees, the next release is not a patch.",
    ).toBe(recorded);
  });
});
