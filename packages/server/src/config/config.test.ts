import { describe, expect, test } from "vitest";

import { normalizeConfig } from "./config.js";

import { type JsonValue } from "../json.js";

const DEV_COMMAND = "pnpm dev --port {port}";

describe("normalizeConfig", () => {
  test("fills in the documented defaults", () => {
    const result = normalizeConfig({ previews: [{ title: "App", url: "/" }] });

    expect(result.config).toMatchObject({
      devServer: "http://localhost:3000",
      scanPreviews: true,
      installCommand: "npm install",
    });
    // An empty array, so the rail never guards for undefined.
    expect(result.config?.previews[0]?.tags).toEqual([]);
  });

  test("lets expensive apps disable unopened preview scans", () => {
    const result = normalizeConfig({
      scanPreviews: false,
      previews: [{ title: "App", url: "/" }],
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.scanPreviews).toBe(false);
  });

  test("treats a missing config as one preview of the app root", () => {
    const result = normalizeConfig(undefined);

    expect(result.errors).toEqual([]);
    expect(result.config?.previews).toEqual([
      { title: "App", url: "/", note: undefined, tags: [] },
    ]);
  });

  // Each one half-used would misbehave somewhere later, so the whole config is
  // refused and the error names what to fix.
  const rejected: Array<[string, JsonValue, string]> = [
    [
      "a non-boolean preview scan setting",
      { scanPreviews: "no", previews: [{ title: "App", url: "/" }] },
      "scanPreviews must be a boolean.",
    ],
    [
      "a non-boolean record setting",
      { recordSets: "no", previews: [{ title: "App", url: "/" }] },
      "recordSets must be a boolean.",
    ],
    [
      "a preview with no title, since the rail has nothing to show",
      { previews: [{ url: "/" }] },
      "title",
    ],
    ["a preview with no url", { previews: [{ title: "App" }] }, "url"],
    [
      "duplicate titles, which would be indistinguishable in the rail",
      {
        previews: [
          { title: "Wave", url: "/?v=a" },
          { title: "Wave", url: "/?v=b" },
        ],
      },
      "Wave",
    ],
    [
      "a url that is neither absolute nor root-relative",
      // Not "pricing": the error's own hint names "/pricing", so the row could
      // not tell whether the message names the url it refused.
      { previews: [{ title: "App", url: "about" }] },
      "about",
    ],
    [
      "a devServer that is not a valid origin",
      { devServer: "not a url", previews: [{ title: "App", url: "/" }] },
      "devServer",
    ],
    ["previews that is not an array", { previews: "nope" }, "previews"],
    [
      "a branch preview with no dev command, since Leglas has to start that checkout itself",
      { previews: [{ title: "PR", url: "/", branch: "main" }] },
      "devCommand",
    ],
    [
      "a dev command that does not say where the port goes",
      { devCommand: "pnpm dev", previews: [{ title: "PR", url: "/", branch: "main" }] },
      "{port}",
    ],
    [
      "a branch that is not a string",
      { devCommand: DEV_COMMAND, previews: [{ title: "PR", url: "/", branch: 7 }] },
      "branch",
    ],
    [
      "a branch name that could escape a path",
      { devCommand: DEV_COMMAND, previews: [{ title: "PR", url: "/", branch: "../../etc" }] },
      "branch",
    ],
    [
      "a branch with an absolute url, which contradicts itself",
      {
        devCommand: DEV_COMMAND,
        previews: [{ title: "PR", url: "https://staging.example.com/", branch: "main" }],
      },
      "absolute",
    ],
    [
      "a file combined with a url, which claims two sources",
      { previews: [{ title: "A", url: "/", file: "a.html" }] },
      "file",
    ],
    [
      "a file combined with a branch",
      {
        devCommand: "npm run dev -- --port {port}",
        previews: [{ title: "A", file: "a.html", branch: "main" }],
      },
      "branch and a file",
    ],
    [
      "a file that climbs out of the project",
      { previews: [{ title: "A", file: "../outside.html" }] },
      "file",
    ],
    ["a file at an absolute path", { previews: [{ title: "B", file: "/etc/hosts" }] }, "file"],
  ];

  test.each(rejected)("rejects %s", (_name, raw, named) => {
    const result = normalizeConfig(raw);

    expect(result.config).toBeNull();
    expect(result.errors.join(" ")).toContain(named);
  });

  test("allows the same url under different titles", () => {
    const result = normalizeConfig({
      previews: [
        { title: "Baseline", url: "/" },
        { title: "Also baseline", url: "/" },
      ],
    });

    expect(result.errors).toEqual([]);
  });

  test("accepts an absolute url so staging can be compared against local", () => {
    const result = normalizeConfig({
      previews: [{ title: "Staging", url: "https://staging.example.com/" }],
    });

    expect(result.errors).toEqual([]);
  });

  test("reports every problem at once rather than stopping at the first", () => {
    const result = normalizeConfig({
      devServer: "not a url",
      previews: [{ url: "/" }, { title: "App" }],
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  test("names the offending entry by index so the error is actionable", () => {
    const result = normalizeConfig({ previews: [{ title: "Ok", url: "/" }, { url: "/x" }] });

    expect(result.errors.join(" ")).toContain("1");
  });

  test("carries note and tags through untouched", () => {
    const result = normalizeConfig({
      previews: [{ title: "Wave", url: "/?v=wave", note: "Client artwork", tags: ["Hero"] }],
    });

    expect(result.config?.previews[0]).toMatchObject({
      note: "Client artwork",
      tags: ["Hero"],
    });
  });
});
