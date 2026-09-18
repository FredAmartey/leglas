import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { RENAMES_PATH, readRenames, resolveTitle, writeRenames } from "./renames.js";

const scratch = () => mkdtempSync(join(tmpdir(), "leglas-renames-"));

const titles = ["Cool", "Warm", "Aurora"];

describe("resolveTitle", () => {
  test("a config title resolves to itself", () => {
    expect(resolveTitle("Cool", titles, {})).toEqual({ ok: true, title: "Cool" });
  });

  test("a name from the rail resolves to the title the config knows", () => {
    // The whole point: the user says the name their own interface showed them.
    expect(resolveTitle("Sunrise", titles, { Cool: "Sunrise" })).toEqual({
      ok: true,
      title: "Cool",
    });
  });

  test("a config title beats a local nickname of the same word", () => {
    // The shared config is what a teammate sees; a local rename must not
    // shadow it, or two people run the same command on different directions.
    expect(resolveTitle("Warm", titles, { Cool: "Warm" })).toEqual({ ok: true, title: "Warm" });
  });

  test("two directions renamed to one word is refused, not guessed at", () => {
    const resolution = resolveTitle("Calm", titles, { Cool: "Calm", Aurora: "Calm" });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("ambiguous");
    if (resolution.reason !== "ambiguous") return;
    expect(resolution.matches).toEqual(["Cool", "Aurora"]);
  });

  test("a name nothing answers to is unknown", () => {
    expect(resolveTitle("Nope", titles, { Cool: "Sunrise" })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("a rename of a direction that no longer exists resolves nothing", () => {
    expect(resolveTitle("Ghost", titles, { Deleted: "Ghost" })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("the renames file", () => {
  test("survives a write and read round trip", async () => {
    const dir = scratch();
    await writeRenames(dir, { Cool: "Sunrise" });

    expect(await readRenames(dir)).toEqual({ Cool: "Sunrise" });
  });

  test("a project that never renamed anything reads as empty", async () => {
    expect(await readRenames(scratch())).toEqual({});
  });

  test("a corrupt file falls back to the config titles rather than throwing", async () => {
    const dir = scratch();
    mkdirSync(join(dir, ".leglas"), { recursive: true });
    writeFileSync(join(dir, RENAMES_PATH), "{not json", "utf8");

    expect(await readRenames(dir)).toEqual({});
  });

  test("drops entries that are not string pairs, since a browser writes this", async () => {
    const dir = scratch();
    mkdirSync(join(dir, ".leglas"), { recursive: true });
    writeFileSync(
      join(dir, RENAMES_PATH),
      JSON.stringify({ renames: { Cool: "Sunrise", Warm: 7, Aurora: "" } }),
      "utf8",
    );

    expect(await readRenames(dir)).toEqual({ Cool: "Sunrise" });
  });
});
