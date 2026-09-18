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
    /**
     * Above the waiting helpers' own deadlines, so a wait that never lands
     * reports what it was waiting for instead of a bare timeout. Vitest's
     * default 5s ceiling sat under those deadlines and would have won the
     * race, which is why they were tuned down to fit under it and then failed
     * on a loaded machine for being an assertion about speed.
     */
    testTimeout: 30_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
