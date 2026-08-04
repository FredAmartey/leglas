import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runAdd } from "./run-previews.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-add-"));
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

const preview = (over: Record<string, unknown>) => ({
  title: "X",
  url: "/?v-hero=x",
  note: undefined,
  tags: undefined,
  branch: undefined,
  file: undefined,
  basedOn: undefined,
  ...over,
});

describe("runAdd with --based-on", () => {
  test("refuses a direction that is not registered, since that is a typo", async () => {
    const cwd = scratch();
    const { deps, errors } = collect();

    const outcome = await runAdd(
      { preview: preview({ title: "Dusk", basedOn: "Meridian" }), json: false, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(errors.join(" ")).toContain("Meridian");
  });

  test("records the parent when it exists, and it survives the round trip", async () => {
    const cwd = scratch();
    const { deps } = collect();
    await runAdd(
      { preview: preview({ title: "Meridian", url: "/?v-hero=meridian" }), json: false, cwd },
      deps,
    );

    const outcome = await runAdd(
      {
        preview: preview({ title: "Dusk", url: "/?v-hero=dusk", basedOn: "Meridian" }),
        json: false,
        cwd,
      },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(join(cwd, ".leglas/previews.json"), "utf8")) as {
      previews: { title: string; basedOn?: string }[];
    };
    expect(written.previews.find((entry) => entry.title === "Dusk")?.basedOn).toBe("Meridian");
  });
});
