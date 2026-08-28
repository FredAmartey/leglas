import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runLog } from "./run-log.js";

function project(entries: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-log-"));
  if (Object.keys(entries).length > 0) mkdirSync(join(cwd, "design-log"), { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(join(cwd, "design-log", name), body);
  }
  return cwd;
}

function collect() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    deps: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
    lines,
    errors,
  };
}

describe("runLog", () => {
  test("lists newest first, because the slug leads with the date", async () => {
    const cwd = project({
      "2026-08-01-hero.md": "# hero, 2026-08-01\n",
      "2026-08-27-pricing.md": "# pricing, 2026-08-27\n",
    });
    const { deps, lines } = collect();

    const outcome = await runLog({ entry: null, json: false, cwd }, deps);

    expect(outcome.exitCode).toBe(0);
    expect(lines[0]).toContain("2026-08-27-pricing");
    expect(lines[1]).toContain("2026-08-01-hero");
  });

  test("says nothing is recorded rather than failing, on a project that has never kept", async () => {
    const { deps, lines } = collect();

    const outcome = await runLog({ entry: null, json: false, cwd: project({}) }, deps);

    expect(outcome.exitCode).toBe(0);
    expect(lines.join(" ")).toContain("No decisions recorded yet");
  });

  test("prints one entry whole, with or without its extension", async () => {
    const cwd = project({ "2026-08-27-hero.md": "# hero, 2026-08-27\n\nTable won.\n" });

    for (const name of ["2026-08-27-hero", "2026-08-27-hero.md"]) {
      const { deps, lines } = collect();
      const outcome = await runLog({ entry: name, json: false, cwd }, deps);
      expect(outcome.exitCode).toBe(0);
      expect(lines.join("\n")).toContain("Table won.");
    }
  });

  test("refuses an entry that is not there, and says where it looked", async () => {
    const { deps, errors } = collect();

    const outcome = await runLog(
      { entry: "nope", json: false, cwd: project({ "2026-08-27-hero.md": "# hero\n" }) },
      deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(errors.join(" ")).toContain("design-log");
  });

  test("answers json in one envelope, which is what an agent reads", async () => {
    const cwd = project({ "2026-08-27-hero.md": "# hero, 2026-08-27\n" });
    const { deps, lines } = collect();

    await runLog({ entry: null, json: true, cwd }, deps);

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      ok: true,
      dir: "design-log",
      entries: [
        {
          entry: "2026-08-27-hero",
          title: "hero, 2026-08-27",
          file: "design-log/2026-08-27-hero.md",
        },
      ],
    });
  });
});
