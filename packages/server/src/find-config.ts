import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Resolution order within a directory. TypeScript first because it is what the
 * docs show and what editors autocomplete; JSON last because it cannot carry
 * comments and is the least likely hand-authored choice.
 */
export const CONFIG_BASENAMES = [
  "leglas.config.ts",
  "leglas.config.mjs",
  "leglas.config.js",
  "leglas.config.json",
] as const;

/**
 * Walk upward from `startDir`, nearest match first, so running from one app in
 * a monorepo picks that app's config rather than the repository root's.
 * Returns null when the filesystem root is reached without a match.
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
