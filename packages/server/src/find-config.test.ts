import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { CONFIG_BASENAMES, findConfigFile } from "./find-config.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-find-"));
}

describe("findConfigFile", () => {
  test("finds a config in the starting directory", () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), "export default {}");

    expect(findConfigFile(dir)).toBe(join(dir, "leglas.config.ts"));
  });

  test("walks upward, so it works from any subdirectory of a project", () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), "export default {}");
    const nested = join(dir, "src", "app");
    mkdirSync(nested, { recursive: true });

    expect(findConfigFile(nested)).toBe(join(dir, "leglas.config.ts"));
  });

  test("prefers the nearest config, so one app in a monorepo wins over the root", () => {
    const root = scratch();
    writeFileSync(join(root, "leglas.config.ts"), "export default {}");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "leglas.config.ts"), "export default {}");

    expect(findConfigFile(app)).toBe(join(app, "leglas.config.ts"));
  });

  test("returns null when no config exists anywhere above", () => {
    const dir = scratch();

    expect(findConfigFile(dir)).toBeNull();
  });

  test("accepts every documented extension", () => {
    for (const basename of CONFIG_BASENAMES) {
      const dir = scratch();
      writeFileSync(join(dir, basename), "export default {}");

      expect(findConfigFile(dir)).toBe(join(dir, basename));
    }
  });

  test("resolves extensions in a stable order when several exist", () => {
    const dir = scratch();
    for (const basename of CONFIG_BASENAMES) {
      writeFileSync(join(dir, basename), "export default {}");
    }

    expect(findConfigFile(dir)).toBe(join(dir, CONFIG_BASENAMES[0] as string));
  });
});
