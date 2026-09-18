import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { DEFAULT_DEV_SERVER } from "./config.js";
import { loadConfig } from "./load-config.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-load-"));
}

describe("loadConfig", () => {
  test("falls back to the implicit single preview when no config exists", async () => {
    const result = await loadConfig(scratch());

    expect(result.errors).toEqual([]);
    expect(result.path).toBeNull();
    expect(result.config?.previews).toHaveLength(1);
    expect(result.config?.devServer).toBe(DEFAULT_DEV_SERVER);
  });

  test("loads a TypeScript config, including its type annotations", async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "leglas.config.ts"),
      `type Preview = { title: string; url: string };
       const previews: Preview[] = [{ title: "Wave", url: "/?v-hero=wave" }];
       export default { devServer: "http://localhost:5173", previews };`,
    );

    const result = await loadConfig(dir);

    expect(result.errors).toEqual([]);
    expect(result.config?.devServer).toBe("http://localhost:5173");
    expect(result.config?.previews[0]?.title).toBe("Wave");
  });

  test("loads a JSON config", async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "leglas.config.json"),
      JSON.stringify({ previews: [{ title: "App", url: "/" }] }),
    );

    const result = await loadConfig(dir);

    expect(result.errors).toEqual([]);
    expect(result.config?.previews[0]?.title).toBe("App");
  });

  test("reports the file path alongside a validation error, so it is actionable", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), `export default { previews: [{ url: "/" }] };`);

    const result = await loadConfig(dir);

    expect(result.config).toBeNull();
    expect(result.errors.join(" ")).toContain("leglas.config.ts");
    expect(result.errors.join(" ")).toContain("title");
  });

  test("reports a config that throws on import rather than crashing the server", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), `throw new Error("boom");`);

    const result = await loadConfig(dir);

    expect(result.config).toBeNull();
    expect(result.errors.join(" ")).toContain("boom");
  });

  test("reports a config with no default export", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), `export const nope = 1;`);

    const result = await loadConfig(dir);

    expect(result.config).toBeNull();
    expect(result.errors.join(" ")).toContain("default");
  });

  test("returns the resolved path so the CLI can report what it used", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "leglas.config.ts"), `export default { previews: [] };`);

    const result = await loadConfig(dir);

    expect(result.path).toBe(join(dir, "leglas.config.ts"));
  });
});
