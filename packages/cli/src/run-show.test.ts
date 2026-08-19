import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { writeRenames } from "@leglas/server";

import { runAdd } from "./run-previews.js";
import { runShow } from "./run-show.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-show-"));
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

const add = (cwd: string, title: string, url: string) =>
  runAdd(
    {
      preview: { title, url, note: undefined, tags: undefined, branch: undefined, file: undefined, basedOn: undefined, askedFor: undefined },
      json: true,
      cwd,
    },
    collect().deps,
  );

const envelope = (lines: string[]) => JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;

describe("runShow", () => {
  test("answers to the name the rail was renamed to, not just the config title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await writeRenames(cwd, { Cool: "Sunrise" });
    const { deps, lines } = collect();

    // The name a user says out loud is the one their own interface showed them.
    const outcome = await runShow({ title: "Sunrise", json: true, cwd }, deps);

    expect(outcome.exitCode).toBe(0);
    const direction = envelope(lines)["direction"] as Record<string, unknown>;
    expect(direction["title"]).toBe("Cool");
  });

  test("a config title still wins over another direction's local nickname", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Warm", "/?v-hero=warm");
    await writeRenames(cwd, { Cool: "Warm" });
    const { deps, lines } = collect();

    const outcome = await runShow({ title: "Warm", json: true, cwd }, deps);

    expect(outcome.exitCode).toBe(0);
    const direction = envelope(lines)["direction"] as Record<string, unknown>;
    expect(direction["title"]).toBe("Warm");
  });

  test("refuses a nickname two directions share rather than picking one", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Aurora", "/?v-hero=aurora");
    await writeRenames(cwd, { Cool: "Calm", Aurora: "Calm" });
    const { deps, lines } = collect();

    const outcome = await runShow({ title: "Calm", json: true, cwd }, deps);

    expect(outcome.exitCode).toBe(1);
    expect(String(envelope(lines)["error"])).toContain("Cool, Aurora");
  });

  test("an unknown name says why the name it was given may not be a title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    const { deps, lines } = collect();

    const outcome = await runShow({ title: "Nope", json: true, cwd }, deps);

    expect(outcome.exitCode).toBe(1);
    // Sending an agent to leglas list without this reads as "it is gone",
    // because a renamed direction is not listed under the name it was given.
    expect(String(envelope(lines)["error"])).toContain("Renaming one in the rail");
  });
});
