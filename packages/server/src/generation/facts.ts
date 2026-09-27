import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

import { fallbackKey, placeholderSource, readDirections } from "./switch-file.js";

import { isJsonRecord, parseJson } from "../json.js";

/**
 * What a builder is told about the project, read without a model, so every
 * build gets the same picture and none spends turns exploring. Told nothing,
 * builders used the project's copy or fonts in 0 of 3 builds on a copy of a
 * real project (2026-09-24); given these facts, 3 of 3 did, at no cost in
 * time.
 */
export type ProjectFacts = {
  dependencies: string[];
  stylesheet: { path: string; fonts: string[]; tokens: string } | null;
  /** `alt` is what the project's own code says the image shows, or null when it says nothing. */
  images: { path: string; alt: string | null }[];
  /** `key` is the direction it was read from, which is not always the one asked for. */
  example: { key: string; path: string; source: string } | null;
};

const IMAGE = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

const IMAGE_LIMIT = 24;

const EXAMPLE_LINES = 250;

/** A variation starts from the whole of its direction, not a sample of the house style. */
const VARIED_LINES = 600;

/** The first `limit` lines, saying so when there were more, so a build never takes a cut file for the whole. */
function clip(source: string, limit: number): string {
  // A file's last newline ends its last line; it does not start another.
  const lines = source.replace(/\n$/, "").split("\n");

  if (lines.length <= limit) return source;
  const hidden = lines.length - limit;

  return [
    ...lines.slice(0, limit),
    `// … ${hidden} more ${hidden === 1 ? "line" : "lines"}, not shown`,
  ].join("\n");
}

/** Short enough that a direction this size is a re-export, not a design. */
const BASELINE_LINES = 15;

const STUB = /Re-export what your|A first direction for/;

async function text(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

async function firstFile(cwd: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await text(join(cwd, candidate))) !== null) return candidate;
  }

  return null;
}

function cssImports(source: string, from: string): string[] {
  return [...source.matchAll(/import\s+["']([^"']+\.css)["']/g)].map((match) =>
    normalize(join(dirname(from), match[1] ?? "")),
  );
}

/**
 * The stylesheet every page loads: whatever the app's entry imports. Vite
 * names its entry in `index.html`; Next's root layout is the entry there.
 */
async function globalStylesheet(cwd: string): Promise<string | null> {
  const entries: string[] = [];
  const html = await text(join(cwd, "index.html"));
  const script = html === null ? null : /<script[^>]+type="module"[^>]+src="\/?([^"]+)"/.exec(html);

  if (script?.[1] !== undefined) entries.push(script[1]);

  for (const root of ["app", "src/app"]) {
    for (const extension of ["tsx", "jsx", "ts", "js"]) entries.push(`${root}/layout.${extension}`);
  }

  const sheets: string[] = [];

  for (const entry of entries) {
    const source = await text(join(cwd, entry));

    if (source !== null) sheets.push(...cssImports(source, entry));
  }

  for (const sheet of sheets) {
    const source = await text(join(cwd, sheet));

    if (source !== null && /:root\s*\{|@font-face/.test(source)) return sheet;
  }

  return firstFile(cwd, sheets);
}

async function images(cwd: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (folder: string): Promise<void> => {
    let items;

    try {
      items = await readdir(join(cwd, "public", folder), { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (found.length >= IMAGE_LIMIT || item.name.startsWith(".")) continue;
      const path = folder === "" ? item.name : `${folder}/${item.name}`;

      if (item.isDirectory()) await walk(path);
      else if (IMAGE.test(item.name)) found.push(`/${path}`);
    }
  };

  await walk("");

  return found;
}

const CODE = /\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|html|mdx)$/i;

/**
 * Only the app's source roots, as `findSwitch` walks: a whole-project walk
 * reaches `src-tauri/target`.
 */
const CODE_ROOTS = ["src", "app", "components", "pages"];

const CODE_LIMIT = 400;

/** A generated data file can run to megabytes; alt text lives in components. */
const CODE_BYTES = 256 * 1024;

const ALT = /(?<![\w.-])alt["']?\s*[=:]\s*\{?\s*(["'`])((?:\\.|(?!\1)[^\\\n]){3,160})\1/;

/** One tag, its attribute values quoted or in braces, two deep for `style={{…}}`. */
const TAG =
  /<[A-Za-z][\w.:-]*(?:"[^"]*"|'[^']*'|`[^`]*`|\{(?:[^{}]|\{[^{}]*\})*\}|[^<>{}"'`])*\/?>/g;

/** One object with no object inside it, as each item in a list of images is. */
const FLAT_OBJECT = /\{[^{}]*\}/g;

/** A brace group in a tag other than one string: a handler, a style or an expression. */
const EXPRESSION = /\{(?!\s*(["'`])[^"'`]*\1\s*\})(?:[^{}]|\{[^{}]*\})*\}/g;

/**
 * Keys whose direct value is the image a tag or object shows. Exact, since
 * `srcBefore`, `data-src` or `event.target.src` may hold another image.
 */
const SOURCE_KEY =
  /(?<![\w.-])(?:src|image|img|photo|poster|cover|href)["']?\s*[=:]\s*\{?\s*["'`]$/i;

async function codeFiles(cwd: string, skip: (path: string) => boolean): Promise<string[]> {
  const found: string[] = [];

  const walk = async (folder: string): Promise<void> => {
    let items;

    try {
      items = await readdir(join(cwd, folder), { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= CODE_LIMIT || item.name.startsWith(".") || item.name === "node_modules")
        continue;
      const path = join(folder, item.name);

      if (item.isDirectory()) await walk(path);
      else if (CODE.test(item.name) && !skip(path)) found.push(path);
    }
  };

  for (const root of CODE_ROOTS) await walk(root);

  return found;
}

function names(piece: string, path: string): boolean {
  for (let at = piece.indexOf(path); at !== -1; at = piece.indexOf(path, at + 1)) {
    if (SOURCE_KEY.test(piece.slice(Math.max(0, at - 48), at))) return true;
  }

  return false;
}

/**
 * An alt describes an image only when one tag or one flat object holds both,
 * the image as its `src` or the like, and names no other. Anything else gives
 * nothing: a fallback, a variable or a neighbour's path would take its words.
 */
function readAlts(source: string, paths: readonly string[], alts: Map<string, string>): void {
  const pieces = [
    ...[...source.matchAll(TAG)].map(([tag]) => tag.replace(EXPRESSION, "{}")),
    ...[...source.matchAll(FLAT_OBJECT)].map(([object]) => object),
  ];

  for (const piece of pieces) {
    const alt = ALT.exec(piece)?.[2]?.replace(/\\(.)/g, "$1").trim();

    if (alt === undefined || alt.includes("${")) continue;
    const [only, ...more] = paths.filter((path) => names(piece, path));

    if (only !== undefined && more.length === 0 && !alts.has(only)) alts.set(only, alt);
  }
}

/**
 * Builds can't see the images, so they're told the alt text the project gives
 * each. Directions are read last, in switch order, and nothing else in the
 * switch's folder is: builds append theirs and guess, and a direction taken
 * off the switch keeps its file.
 */
async function describedImages(cwd: string, switchPath: string): Promise<ProjectFacts["images"]> {
  const paths = await images(cwd);

  if (paths.length === 0) return [];
  const source = await text(join(cwd, switchPath));
  const directions: string[] = [];

  for (const direction of source === null ? [] : readDirections(source)) {
    const path = await componentFile(cwd, switchPath, direction.from);

    if (path !== null) directions.push(normalize(path));
  }

  const folder = normalize(dirname(switchPath));
  const skip = (path: string) => dirname(path) === folder || directions.includes(path);
  const alts = new Map<string, string>();

  for (const file of [...(await codeFiles(cwd, skip)), ...directions]) {
    if (alts.size === paths.length) break;

    const size = (await stat(join(cwd, file)).catch(() => null))?.size ?? Infinity;
    const body = size > CODE_BYTES ? null : await text(join(cwd, file));

    if (body !== null) readAlts(body, paths, alts);
  }

  return paths.map((path) => ({ path, alt: alts.get(path) ?? null }));
}

/** Resolves an import in `from` to a project-relative file. */
export async function componentFile(
  cwd: string,
  from: string,
  specifier: string,
): Promise<string | null> {
  const base = normalize(join(dirname(from), specifier));

  return firstFile(cwd, [
    base,
    ...["tsx", "jsx", "ts", "js"].map((extension) => `${base}.${extension}`),
  ]);
}

/**
 * A direction the builders can copy the house style from: the one the switch
 * shows by default, then any other, skipping placeholders. A baseline that
 * only re-exports the real component is followed one step to it.
 */
async function example(
  cwd: string,
  switchPath: string,
  prefer: string | null,
): Promise<ProjectFacts["example"]> {
  const source = await text(join(cwd, switchPath));

  if (source === null) return null;
  const directions = readDirections(source);
  const first = prefer ?? fallbackKey(source);
  const ordered = [...directions].sort((a, b) => Number(b.key === first) - Number(a.key === first));

  for (const direction of ordered) {
    const limit = direction.key === prefer ? VARIED_LINES : EXAMPLE_LINES;
    const path = await componentFile(cwd, switchPath, direction.from);
    const body = path === null ? null : await text(join(cwd, path));

    if (
      path === null ||
      body === null ||
      body === placeholderSource(direction.name) ||
      STUB.test(body)
    )
      continue;

    if (body.split("\n").length < BASELINE_LINES) {
      const target = /from\s+["'](\.[^"']+)["']/.exec(body)?.[1];
      const followed = target === undefined ? null : await componentFile(cwd, path, target);
      const real = followed === null ? null : await text(join(cwd, followed));

      if (followed !== null && real !== null) {
        return {
          key: direction.key,
          path: followed,
          source: clip(real, limit),
        };
      }

      continue;
    }

    return { key: direction.key, path, source: clip(body, limit) };
  }

  return null;
}

async function dependencyNames(cwd: string): Promise<string[]> {
  try {
    const pkg = parseJson((await text(join(cwd, "package.json"))) ?? "");

    return isJsonRecord(pkg) && isJsonRecord(pkg.dependencies) ? Object.keys(pkg.dependencies) : [];
  } catch {
    // No package.json, or one that does not parse: the builders are not told.
    return [];
  }
}

/** `prefer` names a direction to show as the example, such as the one a set of variations is based on. */
export async function readProjectFacts(
  cwd: string,
  switchPath: string,
  prefer: string | null = null,
): Promise<ProjectFacts> {
  const dependencies = await dependencyNames(cwd);
  const sheetPath = await globalStylesheet(cwd);
  const css = sheetPath === null ? null : await text(join(cwd, sheetPath));

  return {
    dependencies,
    stylesheet:
      sheetPath === null || css === null
        ? null
        : {
            path: sheetPath,
            fonts: [
              ...new Set(
                [...css.matchAll(/font-family:\s*["']([^"']+)["']/g)].map(
                  (match) => match[1] ?? "",
                ),
              ),
            ],
            tokens: /:root\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? "",
          },
    images: await describedImages(cwd, switchPath),
    example: await example(cwd, switchPath, prefer),
  };
}

/**
 * The facts as the paragraph a build prompt carries, leaving out whatever the
 * project does not have. `varied` is the direction a set of variations is
 * based on; the example is named as it only when it was read from it.
 */
export function factsBlock(
  facts: ProjectFacts,
  surface: string,
  varied: { title: string; key: string } | null = null,
): string {
  const lines = [
    "Leglas read the project for you. Follow its house style: differ in the idea, not in the craft.",
  ];

  if (facts.dependencies.length > 0) lines.push(`Dependencies: ${facts.dependencies.join(", ")}.`);

  if (facts.stylesheet !== null) {
    const fonts =
      facts.stylesheet.fonts.length === 0
        ? ""
        : ` It declares the fonts ${facts.stylesheet.fonts.join(", ")}.`;

    lines.push(
      `The global stylesheet ${facts.stylesheet.path} is already loaded on every page.${fonts}`,
    );

    if (facts.stylesheet.tokens !== "")
      lines.push("It sets these tokens:", "```css", facts.stylesheet.tokens, "```");
  }

  if (facts.images.length > 0) {
    const list = facts.images
      .map((image) => (image.alt === null ? image.path : `${image.path} ("${image.alt}")`))
      .join(", ");

    lines.push(
      facts.images.some((image) => image.alt !== null)
        ? `Images the project already serves from its root, with the alt text its code gives them: ${list}.`
        : `Images the project already serves from its root: ${list}.`,
    );
  }

  if (facts.example !== null) {
    lines.push(
      varied?.key === facts.example.key
        ? `${varied.title}, the direction being varied, is ${facts.example.path}. Its imports are relative to that file:`
        : `The ${surface}'s current direction, ${facts.example.path}, shows how directions here are written:`,
      "```tsx",
      facts.example.source.trimEnd(),
      "```",
    );
  }

  return lines.join("\n");
}
