import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { appendRequest, clearRequests, collectRequests, composeRequest, readRequests, targetFor } from "./requests.js";
import type { Preview } from "./config.js";

const preview = (title: string, url: string): Preview => ({
  title,
  url,
  note: undefined,
  tags: [],
});

describe("targetFor", () => {
  test("derives the file from a url the scaffold generated", () => {
    expect(targetFor("/?v-hero=aurora")).toBe(".leglas/variants/hero/aurora.tsx");
  });

  test("works when the variant param is not the only one", () => {
    expect(targetFor("/pricing?utm=x&v-hero=aurora")).toBe(".leglas/variants/hero/aurora.tsx");
  });

  test("returns nothing for a url that is not a variant of a surface", () => {
    expect(targetFor("/pricing")).toBeNull();
  });

  test("returns nothing for an absolute url, which is not ours to edit", () => {
    expect(targetFor("https://staging.example.com/?v-hero=aurora")).toBeNull();
  });

  test("ignores a param that merely looks similar", () => {
    expect(targetFor("/?variant=aurora")).toBeNull();
  });

  test("refuses a value that would escape the variants directory", () => {
    expect(targetFor("/?v-hero=../../etc/passwd")).toBeNull();
  });
});

describe("composeRequest", () => {
  test("names the direction so the agent knows what is being changed", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "make it warmer");

    expect(prompt).toContain("Aurora");
    expect(prompt).toContain("make it warmer");
  });

  test("points at the exact file when the url reveals one", () => {
    const { prompt, target } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer");

    expect(target).toBe(".leglas/variants/hero/aurora.tsx");
    expect(prompt).toContain(".leglas/variants/hero/aurora.tsx");
  });

  test("still produces a usable prompt when the file cannot be derived", () => {
    const { prompt, target } = composeRequest(preview("Pricing v2", "/pricing-v2"), "tighten it");

    expect(target).toBeNull();
    expect(prompt).toContain("Pricing v2");
    expect(prompt).toContain("/pricing-v2");
  });

  test("tells the agent to change only this direction, not its siblings", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer");

    expect(prompt.toLowerCase()).toContain("only");
  });

  test("does not ask the agent to re-register a direction that already exists", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer");

    expect(prompt).not.toContain("leglas add");
  });

  test("trims the intent, so padding from a textarea does not reach the agent", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "  warmer\n\n");

    expect(prompt).toContain("What to change: warmer");
    expect(prompt).not.toMatch(/\n{3}/);
  });
});

describe("request lifecycle", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "leglas-requests-"));
  const input = { title: "Aurora", url: "/", intent: "warmer", target: null, prompt: "prompt" };

  test("append assigns an id and queued status", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const [request] = await readRequests(root);
    expect(request).toMatchObject({ title: "Aurora", id: expect.any(String), status: "queued" });
  });

  test("collect marks requests picked-up and persists", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const collected = await collectRequests(root);
    expect(collected[0]?.status).toBe("picked-up");
    expect((await readRequests(root))[0]?.status).toBe("picked-up");
  });

  test("collecting an empty queue leaves no trace on disk", async () => {
    const root = cwd();
    expect(await collectRequests(root)).toEqual([]);
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });

  test("reads legacy entries with a stable fallback id", async () => {
    const root = cwd();
    const queue = join(root, ".leglas/requests.json");
    mkdirSync(join(root, ".leglas"));
    writeFileSync(queue, JSON.stringify({ requests: [input] }));
    expect(await readRequests(root)).toEqual([{ ...input, id: "0", status: "queued" }]);
    expect(JSON.parse(readFileSync(queue, "utf8"))).toEqual({ requests: [input] });
  });

  test("clear empties the queue", async () => {
    const root = cwd();
    await appendRequest(root, input);
    await clearRequests(root);
    expect(await readRequests(root)).toEqual([]);
  });
});
