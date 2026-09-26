import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Worktrees live inside the repo, so a bare run collected every copy of
     * every test, and fresh worktrees fail `api-surface.test.ts` for lack of a
     * build. A pre-tag verify that cries wolf defeats the tag guard.
     */
    /**
     * Above the waiting helpers' own deadlines, so a wait that never lands
     * names what it waited for. Vitest's default 5s sat under them.
     */
    testTimeout: 30_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/evals/**"],
  },
});
