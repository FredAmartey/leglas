import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What `leglas` and `leglas-mcp` promise to anyone who imports them. Both ship
 * `types`, so a changed signature breaks consumers even if nothing here fails
 * (#6 changed two that way). The snapshot beside this file is the promise, the
 * test compares the build with it, and publish.yml refuses a patch tag when it
 * moved.
 *
 * Reads the emitted `.d.ts`: TypeScript 7 has no compiler API in JavaScript,
 * and the declarations are what the tarball actually ships.
 */

/** Entry modules, by the name a consumer types into `npm install`. */
const ENTRIES = [
  ["leglas", "packages/cli"],
  ["leglas-mcp", "packages/mcp"],
] as const;

/** Workspace packages are re-exported by name, and resolve to a sibling. */
const WORKSPACE = {
  "@leglas/server": "packages/server",
} as const;

function isWorkspace(specifier: string): specifier is keyof typeof WORKSPACE {
  return Object.hasOwn(WORKSPACE, specifier);
}

export const SNAPSHOT = "api-surface.txt";

/**
 * Declarations are build output, so this needs `pnpm build` first. The message
 * says so instead of reporting an empty surface.
 */
function declarations(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} is missing. Run \`pnpm build\` first.`);
  }
}

/**
 * Blanks out everything but code, keeping each character's position. Depth
 * counting must skip comments and strings: `tsc` copies JSDoc verbatim, and one
 * unmatched bracket in prose used to swallow a declaration without any error.
 */
function maskNonCode(source: string): string {
  const masked = source.split("");
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < masked.length; at += 1) {
      if (masked[at] !== "\n") masked[at] = " ";
    }
  };

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    const quote = source[index];

    if (quote === '"' || quote === "'" || quote === "`") {
      let at = index + 1;

      while (at < source.length) {
        if (source[at] === "\\") {
          at += 2;
          continue;
        }

        if (source[at] === quote) break;
        at += 1;
      }

      // Blank the interior only; the quotes themselves are not brackets.
      blank(index + 1, at);
      index = at + 1;
      continue;
    }

    index += 1;
  }

  return masked.join("");
}

/**
 * Splits a `.d.ts` into its top-level declarations by name. Hand-rolled, since
 * compiler output is regular: one declaration per statement, balanced brackets,
 * no JSX. Decisions read the masked copy and lines come from the original, so
 * comments reach the snapshot without being counted.
 */
export function topLevelDeclarations(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = source.split("\n");
  const code = maskNonCode(source).split("\n");

  let depth = 0;
  let current: string[] | null = null;
  let name: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const bare = code[index] ?? "";

    if (current === null) {
      // `export declare function f(`, `export type T =`, `export interface I`,
      // `export declare const C`, `export declare class X`. The name is the
      // first identifier after the keywords that introduce a declaration.
      const start =
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
          bare,
        );

      if (start === null) continue;
      current = [];
      name = start[1] ?? null;
    }

    current.push(line);

    for (const character of bare) {
      if (character === "{" || character === "(" || character === "[") depth += 1;

      if (character === "}" || character === ")" || character === "]") depth -= 1;
    }

    // Balanced again and the statement has visibly ended.
    if (depth <= 0 && /[;}]\s*$/.test(bare.trimEnd())) {
      if (name !== null) found.set(name, current.join("\n").trim());
      depth = 0;
      current = null;
      name = null;
    }
  }

  return found;
}

type Reexport = { names: string[]; from: string };

/**
 * The entry `.d.ts` is only re-exports: take the names here, then each
 * declaration from the module that owns it.
 */
function reexports(source: string): Reexport[] {
  const found: Reexport[] = [];
  const pattern = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

  for (const match of source.matchAll(pattern)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => (entry.split(/\s+as\s+/).pop() ?? "").trim())
      .filter((entry) => entry !== "");

    found.push({ names, from: match[2] ?? "" });
  }

  return found;
}

/**
 * Where a specifier's declarations live. Relative specifiers resolve beside the
 * file that named them, so the directory travels with the walk:
 * `@leglas/server`'s `./requests.js` means a file in its dist, not ours.
 */
function moduleFile(root: string, from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return join(from, `${specifier.replace(/^\.\//, "").replace(/\.js$/, "")}.d.ts`);
  }

  const workspace = isWorkspace(specifier) ? WORKSPACE[specifier] : undefined;

  return workspace === undefined ? null : join(root, workspace, "dist", "index.d.ts");
}

type Parsed = { declarations: Map<string, string>; reexports: Reexport[] };

const parsedFiles = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const already = parsedFiles.get(file);

  if (already !== undefined) return already;

  const source = declarations(file);
  const result = { declarations: topLevelDeclarations(source), reexports: reexports(source) };
  parsedFiles.set(file, result);

  return result;
}

type Resolution =
  | { kind: "found"; text: string }
  /** The chain leaves this repository, so there is nothing further to read. */
  | { kind: "external"; from: string }
  | { kind: "missing" };

/**
 * Finds one name along the path it travels: the module the export names, then
 * wherever that re-exports it from. Not a flat index, where a local helper
 * reached first could shadow a public declaration of the same name and the
 * snapshot would describe the wrong type.
 */
export function resolve(root: string, file: string, name: string, seen: Set<string>): Resolution {
  if (seen.has(file)) return { kind: "missing" };
  seen.add(file);

  const { declarations: own, reexports: onward } = parse(file);
  const text = own.get(name);

  if (text !== undefined) return { kind: "found", text };

  const directory = file.slice(0, file.lastIndexOf("/"));

  for (const { names, from } of onward) {
    if (!names.includes(name)) continue;

    const next = moduleFile(root, directory, from);

    if (next === null) return { kind: "external", from };

    const found = resolve(root, next, name, seen);

    if (found.kind !== "missing") return found;
  }

  return { kind: "missing" };
}

/** Sorted by name, so reordering an export list isn't a diff. */
export function publicSurface(root: string): string {
  const sections: string[] = [
    "# Public API surface",
    "#",
    "# Generated by `pnpm api:update`, from the built .d.ts. Do not edit by hand.",
    "# A change here changes what npm serves. See api-surface.ts.",
  ];

  for (const [packageName, packageDirectory] of ENTRIES) {
    const entryFile = join(root, packageDirectory, "dist", "index.d.ts");

    const described = parse(entryFile)
      .reexports.flatMap(({ names }) =>
        names.map((name) => {
          const found = resolve(root, entryFile, name, new Set());

          if (found.kind === "found") return { name, text: found.text };

          if (found.kind === "external") {
            return { name, text: `export ${name}; // from ${found.from}, not resolved` };
          }

          /**
           * Every file on the chain was ours and was read, so a missing name is
           * a reader bug. Refused, since a silent gap here is a gap in the
           * release gate.
           */
          throw new Error(
            `${packageName} exports ${name}, but no module on the chain declares it. ` +
              "api-surface.ts failed to parse something.",
          );
        }),
      )
      // By name, not text, so a changed signature doesn't move its entry.
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    sections.push("", `## ${packageName}`, "", ...described.map((entry) => entry.text));
  }

  return `${sections.join("\n")}\n`;
}

/**
 * `pnpm api:update` writes the snapshot. The test imports the same function, so
 * writer and checker can't disagree.
 */
if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  writeFileSync(join(root, SNAPSHOT), publicSurface(root));
  process.stdout.write(`${SNAPSHOT} updated\n`);
}
