import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runKeep } from "./run-keep.js";
import { runAdd } from "./run-previews.js";

/** A project holding one direction the way `leglas new` writes it. */
async function project(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-keep-"));
  mkdirSync(join(cwd, ".leglas/variants/hero"), { recursive: true });
  writeFileSync(
    join(cwd, ".leglas/variants/hero/aurora.tsx"),
    "export function Aurora() {\n  return <h1>Aurora</h1>;\n}\n",
  );
  await runAdd(
    {
      preview: {
        title: "Aurora",
        url: "/?v-hero=aurora",
        note: undefined,
        tags: undefined,
        branch: undefined,
        file: undefined,
        basedOn: undefined,
        askedFor: undefined,
      },
      json: true,
      cwd,
    },
    { log: () => {}, error: () => {} },
  );

  return cwd;
}

type KeepEnvelope = { to?: string; error?: string };

const lastEnvelope = (lines: string[]): KeepEnvelope => JSON.parse(lines.at(-1) ?? "{}");

async function keep(cwd: string, to: string) {
  const lines: string[] = [];

  const { exitCode } = await runKeep(
    { title: "Aurora", to, json: true, cwd },
    { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  );

  return { exitCode, envelope: lastEnvelope(lines) };
}

describe("runKeep", () => {
  // The documented form, docs/agents.md: keep "Aurora" --to src/components/hero.tsx.
  test("a relative destination lands inside the project", async () => {
    const cwd = await project();

    const { exitCode, envelope } = await keep(cwd, "src/components/hero.tsx");

    expect(exitCode).toBe(0);
    expect(envelope.to).toBe("src/components/hero.tsx");
    expect(existsSync(join(cwd, "src/components/hero.tsx"))).toBe(true);
    expect(existsSync(join(cwd, ".leglas/variants/hero"))).toBe(false);
  });

  // Agents tend to pass absolute paths. One inside the project names the same
  // file as its relative form, so it lands where the relative one would.
  test("an absolute destination inside the project lands where the relative one would", async () => {
    const cwd = await project();

    const { exitCode, envelope } = await keep(cwd, join(cwd, "src/components/hero.tsx"));

    expect(exitCode).toBe(0);
    expect(envelope.to).toBe("src/components/hero.tsx");
    expect(existsSync(join(cwd, "src/components/hero.tsx"))).toBe(true);
  });

  test("an absolute destination outside the project is refused and nothing moves", async () => {
    const cwd = await project();
    const outside = join(mkdtempSync(join(tmpdir(), "leglas-elsewhere-")), "hero.tsx");

    const { exitCode, envelope } = await keep(cwd, outside);

    expect(exitCode).toBe(1);
    expect(envelope.error).toBe("The destination has to be inside the project.");
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(cwd, ".leglas/variants/hero/aurora.tsx"))).toBe(true);
  });
});
