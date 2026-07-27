import { describe, expect, test } from "vitest";

import { composeRequest, targetFor } from "./requests.js";
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
