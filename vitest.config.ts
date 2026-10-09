import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url)).replaceAll("\\", "/");

export default defineConfig({
  test: {
    /**
     * Above the waiting helpers' own deadlines, so a wait that never lands
     * names what it waited for; Vitest's 5s default sits under them.
     */
    testTimeout: 30_000,
    /**
     * Worktrees live inside the repo, so a bare run would collect every copy
     * of every test, and fresh worktrees fail `api-surface.test.ts` for lack of a
     * build. A pre-tag verify that cries wolf defeats the tag guard.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/evals/**"],
    /**
     * Off unless asked for with `pnpm test:coverage`. Every source file is
     * listed, so one whose tests are all gone reads 0% instead of leaving the
     * total. Vitest matches these patterns anywhere in a file's absolute path,
     * so the excludes are anchored to this checkout; unanchored, the `.claude`
     * one would drop every file of a checkout that is itself a worktree.
     */
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "site/*.ts", "scripts/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/test-helpers.ts",
        "**/dist/**",
        "evals/**",
        ".claude/**",
        ".leglas/**",
      ].map((pattern) => `${root}${pattern}`),
      reporter: ["text-summary", "json-summary", "json"],
      // A test that fails for want of IPv6 or a browser still leaves a report.
      reportOnFailure: true,
    },
  },
});
