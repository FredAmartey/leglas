import { describe, expect, test } from "vitest";

import { normalizeConfig } from "./config.js";

import { type JsonValue } from "../json.js";

const ok = (raw: JsonValue) => {
  const result = normalizeConfig(raw);

  if (result.config === null) throw new Error(`expected valid, got: ${result.errors.join(", ")}`);

  return result.config;
};

describe("previews backed by a branch", () => {
  test("accepts a preview that names a branch, and keeps its dev command", () => {
    const config = ok({
      devCommand: "pnpm dev --port {port}",
      previews: [
        { title: "PR 204", url: "/", branch: "feature/new-hero" },
        { title: "Current", url: "/" },
      ],
    });

    expect(config.previews[0]?.branch).toBe("feature/new-hero");
    expect(config.devCommand).toBe("pnpm dev --port {port}");
    // An ordinary preview beside it is not a branch.
    expect(config.previews[1]?.branch).toBeUndefined();
  });

  test("accepts an install command", () => {
    expect(
      ok({
        devCommand: "pnpm dev --port {port}",
        installCommand: "pnpm install --frozen-lockfile",
        previews: [],
      }).installCommand,
    ).toBe("pnpm install --frozen-lockfile");
  });
});

describe("normalizing without the devCommand coupling", () => {
  test("accepts a lone branch preview when asked, for the local previews file", () => {
    const result = normalizeConfig(
      { previews: [{ title: "PR", url: "/", branch: "main" }] },
      { requireDevCommand: false },
    );

    expect(result.config).not.toBeNull();
    expect(result.config?.previews[0]?.branch).toBe("main");
  });

  test("still validates everything else about the preview", () => {
    const result = normalizeConfig(
      { previews: [{ title: "PR", url: "/", branch: "../../etc" }] },
      { requireDevCommand: false },
    );

    expect(result.config).toBeNull();
  });
});

describe("previews backed by a file", () => {
  test("accepts a file with no url, whose url Leglas assigns at boot", () => {
    const config = ok({ previews: [{ title: "Aurora", file: ".leglas/pages/aurora.html" }] });

    expect(config.previews[0]?.file).toBe(".leglas/pages/aurora.html");
    expect(config.previews[0]?.url).toBe("");
  });
});
