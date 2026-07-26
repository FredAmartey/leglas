import { describe, expect, test } from "vitest";

import { DEFAULT_DEV_SERVER, normalizeConfig } from "./config.js";

describe("normalizeConfig", () => {
  test("accepts a config with one preview", () => {
    const result = normalizeConfig({ previews: [{ title: "App", url: "/" }] });

    expect(result.errors).toEqual([]);
    expect(result.config?.previews).toHaveLength(1);
  });

  test("defaults devServer when the config omits it", () => {
    const result = normalizeConfig({ previews: [{ title: "App", url: "/" }] });

    expect(result.config?.devServer).toBe(DEFAULT_DEV_SERVER);
  });

  test("treats a missing config as one preview of the app root", () => {
    const result = normalizeConfig(undefined);

    expect(result.errors).toEqual([]);
    expect(result.config?.previews).toEqual([
      { title: "App", url: "/", note: undefined, tags: [] },
    ]);
  });

  test("rejects a preview with no title, since the rail has nothing to show", () => {
    const result = normalizeConfig({ previews: [{ url: "/" }] });

    expect(result.errors.join(" ")).toContain("title");
    expect(result.config).toBeNull();
  });

  test("rejects a preview with no url", () => {
    const result = normalizeConfig({ previews: [{ title: "App" }] });

    expect(result.errors.join(" ")).toContain("url");
  });

  test("rejects duplicate titles, which would be indistinguishable in the rail", () => {
    const result = normalizeConfig({
      previews: [
        { title: "Wave", url: "/?v=a" },
        { title: "Wave", url: "/?v=b" },
      ],
    });

    expect(result.errors.join(" ")).toContain("Wave");
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

  test("rejects a url that is neither absolute nor root-relative", () => {
    const result = normalizeConfig({ previews: [{ title: "App", url: "pricing" }] });

    expect(result.errors.join(" ")).toContain("pricing");
  });

  test("accepts an absolute url so staging can be compared against local", () => {
    const result = normalizeConfig({
      previews: [{ title: "Staging", url: "https://staging.example.com/" }],
    });

    expect(result.errors).toEqual([]);
  });

  test("rejects a devServer that is not a valid origin", () => {
    const result = normalizeConfig({
      devServer: "not a url",
      previews: [{ title: "App", url: "/" }],
    });

    expect(result.errors.join(" ")).toContain("devServer");
  });

  test("rejects previews that is not an array", () => {
    const result = normalizeConfig({ previews: "nope" });

    expect(result.errors.join(" ")).toContain("previews");
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

  test("defaults tags to an empty array so the rail never guards for undefined", () => {
    const result = normalizeConfig({ previews: [{ title: "App", url: "/" }] });

    expect(result.config?.previews[0]?.tags).toEqual([]);
  });
});
