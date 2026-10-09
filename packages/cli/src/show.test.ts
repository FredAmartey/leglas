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
  id: `${title}-${intent}`,
  status: "queued",
  title,
  url: "/?v-hero=aurora",
  intent,
  target: ".leglas/variants/hero/aurora.tsx",
  prompt: `In this project, change only the "${title}" design direction.`,
});

describe("planShow", () => {
  test("answers with everything held about the direction, what it is up against and what is pending", () => {
    const plan = planShow({
      title: "Aurora",
      previews,
      requests: [request("Aurora", "warmer"), request("Current", "tighter")],
    });

    if (!plan.ok) throw new Error(plan.error);
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
    expect(plan.variants.map((variant) => variant.title)).toEqual(["Aurora Dusk"]);
    // A direction handed over alone gets improved straight out of the
    // comparison, and its own variants are listed above.
    expect(plan.comparedWith).toEqual(["Current", "Dot grid"]);
    expect(plan.requests.map((entry) => entry.intent)).toEqual(["warmer"]);
  });

  // The file behind it is the one thing nothing else exposes.
  test.each([
    ["a local scaffold direction", "Dot grid", previews, ".leglas/variants/hero/dotgrid.tsx", true],
    [
      "a url outside the scaffold's shape, which has none",
      "Staging",
      [preview("Staging", "https://staging.example.com/pricing")],
      null,
      false,
    ],
    [
      "a file preview, by its own source rather than its url",
      "Sketch",
      [preview("Sketch", "/leglas/files/Sketch/a.html", { file: "pages/a.html" })],
      "pages/a.html",
      false,
    ],
  ])("names the file behind %s", (_case, title, among, target, local) => {
    const plan = planShow({ title, previews: among, requests: [] });

    expect(plan).toMatchObject({ ok: true, direction: { target, local } });
  });

  test("refuses a title that is not registered, the way the other commands do", () => {
    const plan = planShow({ title: "Nope", previews, requests: [] });

    expect(plan.ok).toBe(false);

    if (plan.ok) return;
    expect(plan.error).toContain('No direction called "Nope"');
  });
});
