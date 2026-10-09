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
 * Runs a generated switch for real. The directions beside it are stand-ins that
 * return their own name, so the result is the direction the page would show.
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
  test.each([
    ["a Next app, which reads params on the server", nextPkg, "next"],
    ["a Vite React app, which reads params in the browser", vitePkg, "react"],
    [
      "an unknown framework, by falling back to the browser form",
      JSON.stringify({ dependencies: {} }),
      "react",
    ],
    ["an unreadable package.json, by falling back rather than throwing", "{not json", "react"],
    ["no package.json at all, by falling back", null, "react"],
  ])("recognises %s", (_case, pkg, framework) => {
    expect(detectFramework(pkg)).toBe(framework);
  });
});

describe("surfaceSlug", () => {
  // Spacing and case are normalised so the param is predictable, and characters
  // that would break a query string are stripped.
  test.each([
    ["hero", "hero"],
    ["Hero Backdrop", "hero-backdrop"],
    ["hero/backdrop?x", "herobackdropx"],
  ])("turns %j into %j", (surface, slug) => {
    expect(surfaceSlug(surface)).toBe(slug);
  });
});

describe("planNew", () => {
  const plan = (surface: string, pkg: string | null = nextPkg) =>
    planNew({ surface, packageJson: pkg, gitignore: null });

  test("writes a switcher named for the surface and a first variant, into the ignored directory alone", () => {
    expect(plan("hero").writes.map((write) => write.path)).toEqual([
      ".leglas/variants/hero/switch.tsx",
      ".leglas/variants/hero/current.tsx",
      ".leglas/variants/hero/hero-a.tsx",
    ]);
  });

  test("adds the ignored directory to .gitignore, once", () => {
    expect(plan("hero").gitignore).toContain(".leglas/");
    expect(
      planNew({ surface: "hero", packageJson: nextPkg, gitignore: "node_modules\n.leglas/\n" })
        .gitignore,
    ).toBeNull();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Production renders the fallback whatever the URL says, so a committed
  // branch point can't expose a direction. The development run is the control.
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

  test.each([
    ["on the server for Next", nextPkg, "searchParams", "window.location"],
    ["in the browser for a plain React app", vitePkg, "window.location", "searchParams"],
  ])("reads the param %s", (_where, pkg, reads, avoids) => {
    const switcher = plan("hero", pkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain(reads);
    expect(switcher?.contents).not.toContain(avoids);
  });

  test.each([nextPkg, vitePkg])("exports only the component so edits hot-swap in place", (pkg) => {
    const switcher = plan("hero", pkg).writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).not.toContain("export function resolve");
    expect(switcher?.contents).toContain("export function HeroSwitch");
    expect(switcher?.contents.match(/^export\b/gm)).toHaveLength(1);
  });

  // The placeholders are what a project sees before any direction exists; the
  // baseline is what production always shows.
  test.each([
    ["current", "Current"],
    ["hero-a", "HeroA"],
  ] as const)("the generated %s renders", async (file, component) => {
    const rendered = await renderFile(plan("hero").writes, file, component);

    expect(rendered).toMatchObject({ type: "div" });
  });

  test("the Vite switch compiles without vite/client or @types/node", () => {
    // `import.meta.env` needs vite/client and bare `process` needs @types/node;
    // generated code must compile without either.
    expect(typeErrors(plan("hero", vitePkg).writes)).toBe("");
  });

  test("suggests config entries for the current state and the first direction, on the switch's param", () => {
    const result = plan("hero");
    const switcher = result.writes.find((w) => w.path.endsWith("switch.tsx"));

    expect(switcher?.contents).toContain("v-hero");
    expect(result.previews).toEqual([
      { title: "Current", url: "/?v-hero=current" },
      { title: "Hero A", url: "/?v-hero=hero-a" },
    ]);
  });

  test("tells the user the one wiring change it deliberately did not make", () => {
    const { instructions } = plan("hero");

    expect(instructions).toContain(".leglas/variants/hero/switch");
    expect(instructions.toLowerCase()).toContain("import");
  });
});
