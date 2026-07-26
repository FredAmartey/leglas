import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { LOCAL_PREVIEWS_PATH, addLocalPreview, readLocalPreviews } from "./local-previews.js";
import type { Preview } from "./config.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-local-"));
}

function seed(dir: string, contents: string): void {
  mkdirSync(join(dir, ".leglas"), { recursive: true });
  writeFileSync(join(dir, LOCAL_PREVIEWS_PATH), contents);
}

const shared: Preview[] = [{ title: "Current", url: "/", note: undefined, tags: [] }];

describe("readLocalPreviews", () => {
  test("returns nothing when the project has never added one", async () => {
    const result = await readLocalPreviews(scratch());

    expect(result.previews).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("reads previews that were added locally", async () => {
    const dir = scratch();
    seed(dir, JSON.stringify({ previews: [{ title: "Aurora", url: "/?v-hero=aurora" }] }));

    const result = await readLocalPreviews(dir);

    expect(result.previews).toHaveLength(1);
    expect(result.previews[0]?.title).toBe("Aurora");
  });

  test("marks them local, so the interface can tell shared from unshared", async () => {
    const dir = scratch();
    seed(dir, JSON.stringify({ previews: [{ title: "Aurora", url: "/?v-hero=aurora" }] }));

    const result = await readLocalPreviews(dir);

    expect(result.previews[0]?.local).toBe(true);
  });

  test("reports a corrupt file instead of losing the whole rail", async () => {
    const dir = scratch();
    seed(dir, "{not json");

    const result = await readLocalPreviews(dir);

    expect(result.previews).toEqual([]);
    expect(result.errors.join(" ")).toContain("previews.json");
  });

  test("validates entries the same way the config is validated", async () => {
    const dir = scratch();
    seed(dir, JSON.stringify({ previews: [{ url: "/no-title" }] }));

    const result = await readLocalPreviews(dir);

    expect(result.errors.join(" ")).toContain("title");
  });
});

describe("addLocalPreview", () => {
  test("writes a preview that then reads back", async () => {
    const dir = scratch();

    const outcome = await addLocalPreview(dir, { title: "Aurora", url: "/?v-hero=aurora" }, shared);

    expect(outcome.ok).toBe(true);
    expect((await readLocalPreviews(dir)).previews[0]?.title).toBe("Aurora");
  });

  test("creates the directory when it is the first thing added", async () => {
    const dir = scratch();

    await addLocalPreview(dir, { title: "Aurora", url: "/?v-hero=aurora" }, shared);

    expect(readFileSync(join(dir, LOCAL_PREVIEWS_PATH), "utf8")).toContain("Aurora");
  });

  test("appends rather than replacing what is already there", async () => {
    const dir = scratch();
    await addLocalPreview(dir, { title: "Aurora", url: "/?a" }, shared);
    await addLocalPreview(dir, { title: "Dusk", url: "/?b" }, shared);

    const titles = (await readLocalPreviews(dir)).previews.map((preview) => preview.title);

    expect(titles).toEqual(["Aurora", "Dusk"]);
  });

  test("refuses a title the shared config already uses, which the rail could not tell apart", async () => {
    const dir = scratch();

    const outcome = await addLocalPreview(dir, { title: "Current", url: "/?x" }, shared);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Current");
  });

  test("refuses a title already added locally", async () => {
    const dir = scratch();
    await addLocalPreview(dir, { title: "Aurora", url: "/?a" }, shared);

    const outcome = await addLocalPreview(dir, { title: "Aurora", url: "/?b" }, shared);

    expect(outcome.ok).toBe(false);
  });

  test("refuses a url that is neither root relative nor absolute", async () => {
    const dir = scratch();

    const outcome = await addLocalPreview(dir, { title: "Aurora", url: "pricing" }, shared);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("pricing");
  });

  test("keeps the note and tags it was given", async () => {
    const dir = scratch();
    await addLocalPreview(
      dir,
      { title: "Aurora", url: "/?a", note: "Warm gradient.", tags: ["Hero"] },
      shared,
    );

    const preview = (await readLocalPreviews(dir)).previews[0];

    expect(preview?.note).toBe("Warm gradient.");
    expect(preview?.tags).toEqual(["Hero"]);
  });

  test("writes readable json, since a human may well open it", async () => {
    const dir = scratch();
    await addLocalPreview(dir, { title: "Aurora", url: "/?a" }, shared);

    expect(readFileSync(join(dir, LOCAL_PREVIEWS_PATH), "utf8")).toContain("\n  ");
  });
});
