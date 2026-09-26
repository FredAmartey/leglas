import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRenames } from "@leglas/server";
import { describe, expect, test, vi } from "vitest";

import { readLink } from "../../shell/src/link.js";

import { runLink } from "./run-link.js";
import { runAdd } from "./run-previews.js";
import { NOT_RUNNING } from "./running.js";

async function project(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-link-"));
  const quiet = { log: () => {}, error: () => {} };

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

  await writeRenames(cwd, { Aurora: "Dawn" });

  return cwd;
}

async function link(cwd: string, titles: string[], fetch: typeof globalThis.fetch) {
  const lines: string[] = [];

  const outcome = await runLink(
    { titles, port: 4321, json: true, cwd },
    { log: (line) => lines.push(line), error: (line) => lines.push(line), fetch },
  );

  return { outcome, envelope: JSON.parse(lines[0] ?? "{}") };
}

const serving = (cwd: string) =>
  vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(JSON.stringify({ cwd }), { status: 200 }));

describe("runLink", () => {
  test("opens the pair side by side, taking the name the rail shows", async () => {
    const cwd = await project();
    const { envelope } = await link(cwd, ["Ember", "Dawn"], serving(cwd));
    const url = new URL(envelope.url);

    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:4321/leglas");
    expect(readLink(url.search)).toEqual({ direction: "Ember", compare: "Aurora" });
  });

  test("with no direction named, opens the rail as it is", async () => {
    const cwd = await project();
    const { envelope } = await link(cwd, [], serving(cwd));

    expect(envelope.url).toBe("http://localhost:4321/leglas");
  });

  test("refuses a pair that is one direction under both its names", async () => {
    const cwd = await project();
    const { outcome, envelope } = await link(cwd, ["Aurora", "Dawn"], serving(cwd));

    expect(outcome.exitCode).toBe(1);
    expect(envelope.error).toContain("Both names are Aurora");
  });

  test("says Leglas isn't running when nothing answers", async () => {
    const cwd = await project();
    const refused = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const { outcome, envelope } = await link(cwd, ["Aurora"], refused);

    expect(outcome.exitCode).toBe(1);
    expect(envelope.error).toBe(NOT_RUNNING);
  });
});
