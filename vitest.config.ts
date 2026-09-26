import { defineConfig } from "vitest/config";

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
  },
});
