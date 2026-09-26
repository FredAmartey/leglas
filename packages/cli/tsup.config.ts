import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

/**
 * Self-contained: @leglas/server is bundled in and the built shell ships in
 * dist/shell/. One package, one version, no scope.
 */
// Declarations come from tsc (see the build script); tsup's dts bundler can't
// drive TypeScript 7.
export default defineConfig({
  entry: { bin: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node24",
  clean: true,
  splitting: false,
  // The SDK resolves its platform-native Claude binary at runtime, so it stays
  // external and its optional platform dependency survives packing.
  external: ["@anthropic-ai/claude-agent-sdk"],
  noExternal: [/@leglas\//],
  onSuccess: async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    cpSync(join(here, "../shell/dist"), join(here, "dist/shell"), { recursive: true });
  },
});
