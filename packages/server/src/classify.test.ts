import { describe, expect, test } from "vitest";

import { classifyDirection, type DeclaredChange } from "./classify.js";

const change = (path: string, overrides: Partial<DeclaredChange> = {}): DeclaredChange => ({
  path,
  kind: "change",
  exists: true,
  ...overrides,
});

const rewrite = (path: string, overrides: Partial<DeclaredChange> = {}): DeclaredChange =>
  change(path, { kind: "rewrite", ...overrides });

describe("classifyDirection", () => {
  test("stays in-app for new files beside what exists", () => {
    const placement = classifyDirection({
      changes: [
        change(".leglas/variants/hero/aurora.tsx", { exists: false }),
        change(".leglas/variants/hero/switch.tsx"),
      ],
    });

    expect(placement.level).toBe("in-app");
  });

  test("wiring a branch point into an existing component is additive", () => {
    const placement = classifyDirection({ changes: [change("src/app/page.tsx")] });

    expect(placement.level).toBe("in-app");
  });

  test("routes a dependency change to a checkout", () => {
    const placement = classifyDirection({
      changes: [change("package.json"), change(".leglas/variants/hero/motion.tsx", { exists: false })],
    });

    expect(placement.level).toBe("checkout");
    expect(placement.reason).toContain("package.json");
    expect(placement.reason).toContain("dependency");
  });

  test("a lockfile anywhere in a monorepo counts as a dependency change", () => {
    const placement = classifyDirection({ changes: [change("apps/web/pnpm-lock.yaml")] });

    expect(placement.level).toBe("checkout");
  });

  test("routes build configuration to a checkout", () => {
    for (const path of [
      "next.config.ts",
      "vite.config.mjs",
      "tailwind.config.js",
      "tsconfig.json",
      "apps/web/tsconfig.build.json",
      ".env.local",
      ".babelrc",
      "turbo.json",
    ]) {
      expect(classifyDirection({ changes: [change(path)] }).level).toBe("checkout");
    }
  });

  test("leglas's own config file is registration, not build configuration", () => {
    const placement = classifyDirection({ changes: [change("leglas.config.ts")] });

    expect(placement.level).toBe("in-app");
  });

  test("routes a rewrite of an existing shared file to a checkout", () => {
    const placement = classifyDirection({ changes: [rewrite("src/components/hero.tsx")] });

    expect(placement.level).toBe("checkout");
    expect(placement.reason).toContain("hero.tsx");
  });

  test("a rewrite of a path that does not exist is just a creation", () => {
    const placement = classifyDirection({
      changes: [rewrite("src/components/new-hero.tsx", { exists: false })],
    });

    expect(placement.level).toBe("in-app");
  });

  test("a rewrite of the direction's own exploration files contends with nobody", () => {
    const placement = classifyDirection({
      changes: [rewrite(".leglas/variants/hero/aurora.tsx")],
    });

    expect(placement.level).toBe("in-app");
  });

  test("the dependency reason wins when several rules match", () => {
    const placement = classifyDirection({
      changes: [rewrite("src/components/hero.tsx"), change("next.config.ts"), change("package.json")],
    });

    expect(placement.reason).toContain("dependency");
  });

  test("always says what to do next", () => {
    const inApp = classifyDirection({ changes: [change("src/app/page.tsx")] });
    const checkout = classifyDirection({ changes: [change("package.json")] });

    expect(inApp.steps.join(" ")).toContain("npx leglas add");
    expect(checkout.steps.join(" ")).toContain("--branch");
  });
});
