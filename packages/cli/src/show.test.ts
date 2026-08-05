import { describe, expect, test } from "vitest";

import { planShow } from "./show.js";
import type { PendingRequest, Preview } from "@leglas/server";

const preview = (
  title: string,
  url: string,
  extra: Partial<Preview & { local: boolean }> = {},
): Preview & { local?: boolean } => ({
  title,
  url,
  note: undefined,
  tags: [],
  ...extra,
});

const previews = [
  preview("Current", "/?v-hero=current"),
  preview("Aurora", "/?v-hero=aurora", { note: "Warm, low horizon.", tags: ["Hero"] }),
  preview("Aurora Dusk", "/?v-hero=aurora-dusk", { basedOn: "Aurora" }),
  preview("Dot grid", "/?v-hero=dotgrid", { local: true }),
];

const request = (title: string, intent: string): PendingRequest => ({
  title,
  url: "/?v-hero=aurora",
  intent,
  target: ".leglas/variants/hero/aurora.tsx",
  prompt: `In this project, change only the "${title}" design direction.`,
});

describe("planShow", () => {
  test("answers with everything the config holds about the direction", () => {
    const plan = planShow({ title: "Aurora", previews, requests: [] });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.direction).toEqual({
      title: "Aurora",
      url: "/?v-hero=aurora",
      note: "Warm, low horizon.",
      tags: ["Hero"],
      basedOn: null,
      branch: null,
      file: null,
      local: false,
      target: ".leglas/variants/hero/aurora.tsx",
    });
  });

  test("names the file behind it, which is the one thing nothing else exposes", () => {
    const plan = planShow({ title: "Dot grid", previews, requests: [] });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.direction.target).toBe(".leglas/variants/hero/dotgrid.tsx");
    expect(plan.direction.local).toBe(true);
  });

  test("a url outside the scaffold's shape has no file to name", () => {
    const plan = planShow({
      title: "Staging",
      previews: [preview("Staging", "https://staging.example.com/pricing")],
      requests: [],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.direction.target).toBeNull();
  });

  test("a file preview names its own source rather than decoding a url", () => {
    const plan = planShow({
      title: "Sketch",
      previews: [preview("Sketch", "/leglas/files/Sketch/a.html", { file: "pages/a.html" })],
      requests: [],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.direction.target).toBe("pages/a.html");
  });

  test("gathers the variants that are based on it", () => {
    const plan = planShow({ title: "Aurora", previews, requests: [] });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.variants.map((variant) => variant.title)).toEqual(["Aurora Dusk"]);
  });

  test("says what the direction is up against, without repeating its own variants", () => {
    const plan = planShow({ title: "Aurora", previews, requests: [] });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // An agent handed one direction and nothing else improves it straight out
    // of the comparison, which is the one thing the product exists to prevent.
    expect(plan.comparedWith).toEqual(["Current", "Dot grid"]);
  });

  test("carries only the requests pending against this direction", () => {
    const plan = planShow({
      title: "Aurora",
      previews,
      requests: [request("Aurora", "warmer"), request("Current", "tighter")],
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.requests.map((entry) => entry.intent)).toEqual(["warmer"]);
  });

  test("refuses a title that is not registered, the way the other commands do", () => {
    const plan = planShow({ title: "Nope", previews, requests: [] });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("No direction called \"Nope\"");
  });
});
