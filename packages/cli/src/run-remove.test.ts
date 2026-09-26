import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRenames } from "@leglas/server";
import { describe, expect, test } from "vitest";

import { runAdd, runList } from "./run-previews.js";
import { runRemove } from "./run-remove.js";

const quiet = { log: () => {}, error: () => {} };

/** A project whose config shares Table and whose machine registered Aurora and Ember. */
async function project(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-remove-"));
  writeFileSync(
    join(cwd, "leglas.config.json"),
    JSON.stringify({ previews: [{ title: "Table", url: "/" }] }),
  );

  for (const title of ["Aurora", "Ember"]) {
    const preview = {
      title,
      url: `/?v-hero=${title.toLowerCase()}`,
      note: undefined,
      tags: undefined,
      branch: undefined,
      file: undefined,
      basedOn: undefined,
      askedFor: undefined,
    };

    await runAdd({ preview, json: true, cwd }, quiet);
  }

  return cwd;
}

async function remove(cwd: string, titles: string[]) {
  const lines: string[] = [];

  const outcome = await runRemove(
    { titles, json: true, cwd },
    { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  );

  return { outcome, envelope: JSON.parse(lines[0] ?? "{}") };
}

async function titles(cwd: string): Promise<string[]> {
  const lines: string[] = [];
  await runList({ json: true, cwd }, { log: (line) => lines.push(line), error: () => {} });

  return JSON.parse(lines[0] ?? "{}").previews.map((preview: { title: string }) => preview.title);
}

describe("runRemove", () => {
  test("takes a direction registered on this machine off the rail", async () => {
    const cwd = await project();
    const { outcome, envelope } = await remove(cwd, ["Aurora"]);

    expect(outcome.exitCode).toBe(0);
    expect(envelope).toEqual({ ok: true, removed: ["Aurora"] });
    expect(await titles(cwd)).toEqual(["Table", "Ember"]);
  });

  test("takes the name the rail shows", async () => {
    const cwd = await project();
    await writeRenames(cwd, { Aurora: "Dawn" });

    expect((await remove(cwd, ["Dawn"])).envelope.removed).toEqual(["Aurora"]);
  });

  test("refuses a direction the shared config lists, and removes nothing", async () => {
    const cwd = await project();
    const { outcome, envelope } = await remove(cwd, ["Aurora", "Table"]);

    expect(outcome.exitCode).toBe(1);
    expect(envelope.error).toContain("Table is in leglas.config.json");
    expect(await titles(cwd)).toEqual(["Table", "Aurora", "Ember"]);
  });

  test("says a registry it cannot read is why, and leaves it as it is", async () => {
    const cwd = await project();
    const path = join(cwd, ".leglas", "previews.json");
    const unreadable = `${readFileSync(path, "utf8").replace(/\]\s*\}\s*$/, "")}, { "url": 3 }]}\n`;
    writeFileSync(path, unreadable);

    const { outcome, envelope } = await remove(cwd, ["Aurora"]);

    expect(outcome.exitCode).toBe(1);
    expect(envelope.error).toContain(".leglas/previews.json has entries Leglas can't read");
    expect(readFileSync(path, "utf8")).toBe(unreadable);
  });
});
