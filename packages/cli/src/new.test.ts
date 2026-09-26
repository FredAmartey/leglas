import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { detectFramework, planNew, surfaceSlug, type Write } from "./new.js";

const nextPkg = JSON.stringify({ dependencies: { next: "16.2.0", react: "19.0.0" } });

const vitePkg = JSON.stringify({
  devDependencies: { vite: "7.0.0" },
  dependencies: { react: "19.0.0" },
});

/** The repository's own compiler, so the generated code meets the TypeScript projects use. */
const TSC = join(import.meta.dirname, "../../../node_modules/.bin/tsc");

/** A bare JSX namespace standing in for React's types, which a project brings itself. */
const JSX_TYPES =
  "declare namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: unknown } }\n";

type TsOptions = Record<string, string | boolean | string[]>;

/** Compile generated files in a scratch project; returns its directory and tsc's errors. */
function compile(writes: Write[], compilerOptions: TsOptions) {
  const dir = mkdtempSync(join(tmpdir(), "leglas-switch-"));

  for (const write of writes) writeFileSync(join(dir, basename(write.path)), write.contents);
  writeFileSync(join(dir, "jsx.d.ts"), JSX_TYPES);

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions, include: ["*.tsx", "*.d.ts"] }),
  );

  const result = spawnSync(TSC, ["-p", dir], { encoding: "utf8" });

  return { dir, errors: result.status === 0 ? "" : result.stdout };
}

type Props = { searchParams?: Record<string, string> };

type Element = { type: string; props: Props | null; children: Rendered[] };

type Rendered = string | Element;

type Component = (props: Props) => Rendered;

type Generated = Partial<Record<"HeroSwitch" | "Current" | "HeroA", Component>>;

/**
 * What JSX calls while these tests render: a component is called, and an
 * element such as a placeholder's <div> becomes a plain object.
 */
function renderDirection(
  type: string | Component,
  props: Props | null,
  ...children: Rendered[]
): Rendered {
  return type instanceof Function ? type(props ?? {}) : { type, props, children };
}

/** Compile the generated files to JavaScript that imports its siblings by file name. */
function emit(writes: Write[]): string {
  const { dir } = compile(writes, {
    jsx: "react",
    jsxFactory: "globalThis.renderDirection",
    module: "esnext",
    target: "es2022",
    outDir: "out",
    noCheck: true,
  });

  vi.stubGlobal("renderDirection", renderDirection);

  return dir;
}

async function load(dir: string, name: string, source: string): Promise<Generated> {
  writeFileSync(
    join(dir, `${name}.mjs`),
    source.replace(/from "\.\/([\w-]+)"/g, 'from "./$1.mjs"'),
  );

  return import(pathToFileURL(join(dir, `${name}.mjs`)).href);
}

/**
 * Run a generated switch for real. The directions beside it are stand-ins
 * that return their own name, so the result is the direction the page would
 * show.
 */
async function renderSwitch(writes: Write[], props: Props): Promise<Rendered | undefined> {
  const dir = emit(writes);
  writeFileSync(join(dir, "current.mjs"), 'export const Current = () => "current";\n');
  writeFileSync(join(dir, "hero-a.mjs"), 'export const HeroA = () => "hero-a";\n');

  const { HeroSwitch } = await load(
    dir,
    "switch",
    readFileSync(join(dir, "out/switch.js"), "utf8"),
  );

  return HeroSwitch?.(props);
}

/** Render one generated direction file the way the page would. */
async function renderFile(
  writes: Write[],
  file: string,
  component: "Current" | "HeroA",
): Promise<Rendered | undefined> {
  const dir = emit(writes);
  const loaded = await load(dir, file, readFileSync(join(dir, `out/${file}.js`), "utf8"));

  return loaded[component]?.({});
}

/**
 * Typecheck generated files the way a fresh project would: strict, with the
 * DOM library and no vite/client or @types/node.
 */
function typeErrors(writes: Write[]): string {
  return compile(writes, {
    strict: true,
    noEmit: true,
    jsx: "preserve",
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2022",
    lib: ["es2022", "dom"],
    types: [],
  }).errors;
}

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

    expect(
      paths.some(
        (path) =>
          path.includes("/variants/hero/") && path.endsWith(".tsx") && !path.endsWith("switch.tsx"),
      ),
    ).toBe(true);
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Production renders the fallback whatever the URL says, so a committed
  // branch point cannot expose a direction. The development run is the
  // control: the same URL does pick the direction there.
  test.each([
    ["Next", nextPkg, { searchParams: { "v-hero": "hero-a" } }],
    ["Vite", vitePkg, {}],
  ])("guards production in the %s switch", async (_name, pkg, props) => {
    vi.stubGlobal("window", { location: { search: "?v-hero=hero-a" } });
    const writes = plan("hero", pkg).writes;

    vi.stubEnv("NODE_ENV", "development");
    expect(await renderSwitch(writes, props)).toBe("hero-a");

    vi.stubEnv("NODE_ENV", "production");
    expect(await renderSwitch(writes, props)).toBe("current");
  });

  test("imports nothing from Leglas, so the code outlives the tool", () => {
    for (const write of plan("hero").writes) {
      expect(write.contents).not.toContain("@leglas");
      expect(write.contents).not.toContain('from "leglas"');
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

  test.each([nextPkg, vitePkg])("exports only the component so edits hot-swap in place", (pkg) => {
    const switcher = plan("hero", pkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).not.toContain("export function resolve");
    expect(switcher?.contents).toContain("export function HeroSwitch");
    expect(switcher?.contents.match(/^export\b/gm)).toHaveLength(1);
  });

  // The placeholders are what a project sees before any direction is
  // written, and the baseline is what production always shows.
  test.each([
    ["current", "Current"],
    ["hero-a", "HeroA"],
  ] as const)("the generated %s renders", async (file, component) => {
    const rendered = await renderFile(plan("hero").writes, file, component);

    expect(rendered).toMatchObject({ type: "div" });
  });

  test("the Vite switch compiles without vite/client or @types/node", () => {
    // `import.meta.env` needs vite/client and bare `process` needs @types/node.
    // Generated code has to compile in a project that installed neither.
    expect(typeErrors(plan("hero", vitePkg).writes)).toBe("");
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
