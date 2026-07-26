import { describe, expect, test } from "vitest";

import { detectFramework, planNew, surfaceSlug } from "./new.js";

const nextPkg = JSON.stringify({ dependencies: { next: "16.2.0", react: "19.0.0" } });
const vitePkg = JSON.stringify({ devDependencies: { vite: "7.0.0" }, dependencies: { react: "19.0.0" } });

describe("detectFramework", () => {
  test("recognises a Next app, which reads params on the server", () => {
    expect(detectFramework(nextPkg)).toBe("next");
  });

  test("recognises a Vite React app, which reads params in the browser", () => {
    expect(detectFramework(vitePkg)).toBe("react");
  });

  test("falls back to the browser form when the framework is unknown", () => {
    expect(detectFramework(JSON.stringify({ dependencies: {} }))).toBe("react");
  });

  test("falls back rather than throwing on an unreadable package.json", () => {
    expect(detectFramework("{not json")).toBe("react");
  });

  test("falls back when there is no package.json at all", () => {
    expect(detectFramework(null)).toBe("react");
  });
});

describe("surfaceSlug", () => {
  test("keeps a simple name as-is", () => {
    expect(surfaceSlug("hero")).toBe("hero");
  });

  test("normalises spacing and case so the param is predictable", () => {
    expect(surfaceSlug("Hero Backdrop")).toBe("hero-backdrop");
  });

  test("strips characters that would break a query string", () => {
    expect(surfaceSlug("hero/backdrop?x")).toBe("herobackdropx");
  });
});

describe("planNew", () => {
  const plan = (surface: string, pkg: string | null = nextPkg) =>
    planNew({ surface, packageJson: pkg, gitignore: null });

  test("writes the switcher into the ignored directory, not the user's source", () => {
    const paths = plan("hero").writes.map((write) => write.path);

    expect(paths.every((path) => path.startsWith(".leglas/"))).toBe(true);
  });

  test("names the switcher after the surface", () => {
    const paths = plan("hero").writes.map((write) => write.path);

    expect(paths).toContain(".leglas/variants/hero/switch.tsx");
  });

  test("ships a first variant so there is something to render immediately", () => {
    const paths = plan("hero").writes.map((write) => write.path);

    expect(paths.some((path) => path.includes("/variants/hero/") && path.endsWith(".tsx") && !path.endsWith("switch.tsx"))).toBe(true);
  });

  test("adds the ignored directory to .gitignore", () => {
    expect(plan("hero").gitignore).toContain(".leglas/");
  });

  test("does not add a second .gitignore entry when one is already there", () => {
    const result = planNew({
      surface: "hero",
      packageJson: nextPkg,
      gitignore: "node_modules\n.leglas/\n",
    });

    expect(result.gitignore).toBeNull();
  });

  test("guards production, so a committed branch point cannot expose a direction", () => {
    const switcher = plan("hero").writes.find((write) => write.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain("production");
  });

  test("imports nothing from Leglas, so the code outlives the tool", () => {
    for (const write of plan("hero").writes) {
      expect(write.contents).not.toContain("@leglas");
      expect(write.contents).not.toContain("from \"leglas\"");
    }
  });

  test("reads the param on the server for Next", () => {
    const switcher = plan("hero", nextPkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain("searchParams");
    expect(switcher?.contents).not.toContain("window.location");
  });

  test("reads the param in the browser for a plain React app", () => {
    const switcher = plan("hero", vitePkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain("window.location");
  });

  test("does not depend on bundler globals the project may not have typed", () => {
    // `import.meta.env` needs vite/client and bare `process` needs @types/node.
    // Generated code has to compile in a project that installed neither.
    const switcher = plan("hero", vitePkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).not.toMatch(/(?<!as ImportMeta & \{ env\?: \{ PROD\?: boolean \} \};\n.*)import\.meta\.env\?/);
    expect(switcher?.contents).toContain("globalThis as {");
    expect(switcher?.contents).toContain("ImportMeta & {");
  });

  test("uses the surface name as the query param, matching the config it suggests", () => {
    const result = plan("hero");
    const switcher = result.writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain("v-hero");
    expect(result.previews[0]?.url).toBe("/?v-hero=current");
  });

  test("suggests config entries for the current state and the first direction", () => {
    const titles = plan("hero").previews.map((preview) => preview.title);

    expect(titles).toEqual(["Current", "Hero A"]);
  });

  test("tells the user the one wiring change it deliberately did not make", () => {
    const { instructions } = plan("hero");

    expect(instructions).toContain(".leglas/variants/hero/switch");
    expect(instructions.toLowerCase()).toContain("import");
  });
});
