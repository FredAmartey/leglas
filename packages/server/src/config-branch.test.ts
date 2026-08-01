import { describe, expect, test } from "vitest";

import { normalizeConfig } from "./config.js";

const ok = (raw: unknown) => {
  const result = normalizeConfig(raw);
  if (result.config === null) throw new Error(`expected valid, got: ${result.errors.join(", ")}`);
  return result.config;
};

const errors = (raw: unknown) => normalizeConfig(raw).errors.join(" ");

describe("previews backed by a branch", () => {
  test("accepts a preview that names a branch", () => {
    const config = ok({
      devCommand: "pnpm dev --port {port}",
      previews: [{ title: "PR 204", url: "/", branch: "feature/new-hero" }],
    });

    expect(config.previews[0]?.branch).toBe("feature/new-hero");
  });

  test("leaves branch undefined for an ordinary preview", () => {
    const config = ok({ previews: [{ title: "Current", url: "/" }] });

    expect(config.previews[0]?.branch).toBeUndefined();
  });

  test("requires a dev command, since Leglas has to start that checkout itself", () => {
    expect(errors({ previews: [{ title: "PR", url: "/", branch: "main" }] })).toContain(
      "devCommand",
    );
  });

  test("requires the dev command to say where the port goes", () => {
    expect(
      errors({
        devCommand: "pnpm dev",
        previews: [{ title: "PR", url: "/", branch: "main" }],
      }),
    ).toContain("{port}");
  });

  test("keeps the dev command when it is well formed", () => {
    expect(ok({ devCommand: "pnpm dev --port {port}", previews: [] }).devCommand).toBe(
      "pnpm dev --port {port}",
    );
  });

  test("rejects a branch that is not a string", () => {
    expect(
      errors({
        devCommand: "pnpm dev --port {port}",
        previews: [{ title: "PR", url: "/", branch: 7 }],
      }),
    ).toContain("branch");
  });

  test("rejects a branch name that could escape a path", () => {
    expect(
      errors({
        devCommand: "pnpm dev --port {port}",
        previews: [{ title: "PR", url: "/", branch: "../../etc" }],
      }),
    ).toContain("branch");
  });

  test("rejects combining a branch with an absolute url, which contradicts itself", () => {
    expect(
      errors({
        devCommand: "pnpm dev --port {port}",
        previews: [{ title: "PR", url: "https://staging.example.com/", branch: "main" }],
      }),
    ).toContain("absolute");
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

  test("defaults the install command, since a fresh checkout has no dependencies", () => {
    expect(ok({ previews: [] }).installCommand).toBeTruthy();
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
