import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Worktrees live inside the repo, so a bare run collects every copy of
     * every test: 321 files here against CI's 67. Two of those copies then
     * fail `api-surface.test.ts`, which reads built declarations a fresh
     * worktree has not produced, and a pre-tag verify that reports a surface
     * mismatch when the surface is fine is worse than noise. The tag guard
     * exists to be believed.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
