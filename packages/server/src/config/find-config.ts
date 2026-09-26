import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Resolution order within a directory: TypeScript first, as the docs show it;
 * JSON last, since it can't carry comments.
 */
export const CONFIG_BASENAMES = [
  "leglas.config.ts",
  "leglas.config.mjs",
  "leglas.config.js",
  "leglas.config.json",
] as const;

/**
 * Walks upward from `startDir`, nearest first, so one app in a monorepo gets
 * its own config. Null if the filesystem root has none.
 */
export function findConfigFile(startDir: string): string | null {
  const { root } = parse(startDir);
  let dir = startDir;

  for (;;) {
    for (const basename of CONFIG_BASENAMES) {
      const candidate = join(dir, basename);

      if (existsSync(candidate)) return candidate;
    }

    if (dir === root) return null;
    const parent = dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
}
