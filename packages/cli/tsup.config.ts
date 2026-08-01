import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

/**
 * The published package is self-contained: nobody imports Leglas's internals,
 * so @leglas/server is bundled in and the built shell rides along in
 * dist/shell/. One package to install, one version to publish, no scope.
 */
// Declarations come from tsc (see the build script): tsup's dts bundler
// cannot drive TypeScript 7's native compiler.
export default defineConfig({
  entry: { bin: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node24",
  clean: true,
  splitting: false,
  noExternal: [/@leglas\//],
  onSuccess: async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    cpSync(join(here, "../shell/dist"), join(here, "dist/shell"), { recursive: true });
  },
});
