import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What `leglas` and `leglas-mcp` promise to anyone who imports them.
 *
 * Both packages ship `types`, so their exported signatures are part of what
 * npm serves, and changing one is a breaking change whether or not anything
 * here noticed. #6 changed `registerLeglasTools` and `startChannel` from
 * `{ cwd }` to `{ project }` and nothing failed, because nothing in this
 * repository imports those packages the way a consumer does.
 *
 * So the surface is written down. The snapshot beside this file is the
 * promise, the test compares it against the build, and publish.yml refuses a
 * patch tag when it has moved since the last release. A breaking change then
 * costs two deliberate acts: updating the snapshot, and picking a version that
 * admits what you did.
 *
 * This reads the emitted `.d.ts` rather than the source. TypeScript 7 is the
 * native port and no longer exposes a compiler API to JavaScript, and the
 * declarations are the better answer anyway: they are the artifact in the
 * tarball, so this describes what consumers actually receive rather than what
 * we believe we wrote.
 */

/** Entry modules, by the name a consumer types into `npm install`. */
const ENTRIES = [
  ["leglas", "packages/cli"],
  ["leglas-mcp", "packages/mcp"],
] as const;

/** Workspace packages are re-exported by name, and resolve to a sibling. */
const WORKSPACE: Record<string, string> = {
  "@leglas/server": "packages/server",
};

export const SNAPSHOT = "api-surface.txt";

/**
 * The declarations are build output, so this reads nothing until `pnpm build`
 * has run. CI builds before it tests; locally the message says so rather than
 * surfacing as an empty surface that looks like every export was deleted.
 */
function declarations(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} is missing. Run \`pnpm build\` first.`);
  }
}

/**
 * Blank out everything that is not code, keeping every character's position so
 * the mask can be read line for line against the original.
 *
 * Depth counting has to ignore comments and string literals or it is not
 * counting code. `tsc` copies JSDoc into the declarations verbatim, so an
 * ordinary sentence with one unmatched bracket in it, "Tests gate this (see
 * below", used to unbalance the count and swallow the declaration it was
 * attached to. The name then fell through to the unresolved fallback and read
 * like an external module rather than a parse failure, which is the worst
 * shape a bug in this file can take: the surface it stops describing is the
 * surface it stops protecting, and nothing says so.
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
 * Split a `.d.ts` into its top-level declarations, keyed by the name each one
 * introduces. Hand-rolled because the alternative is a parser dependency for a
 * file shape the compiler generates and therefore never gets creative with:
 * one declaration per top-level statement, brackets balanced, no JSX.
 *
 * Every decision reads the masked copy and every captured line comes from the
 * original, so comments survive into the snapshot without ever being counted.
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
      const start = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
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
 * The entry `.d.ts` is nothing but re-exports, so it names the surface without
 * describing it. Read the names here, then fetch each one's declaration from
 * the module that owns it.
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
 * Where a module specifier's declarations live. Relative specifiers resolve
 * beside the file that named them, which is why the containing directory is
 * carried through the walk rather than assumed to be the package we started
 * in: `leglas` re-exports from `@leglas/server`, and that package's own
 * `./requests.js` means a file in *its* dist, not ours.
 */
function moduleFile(root: string, from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return join(from, `${specifier.replace(/^\.\//, "").replace(/\.js$/, "")}.d.ts`);
  }
  const workspace = WORKSPACE[specifier];
  return workspace === undefined ? null : join(root, workspace, "dist", "index.d.ts");
}

/**
 * Walk a declaration file and everything it re-exports from, collecting every
 * declaration seen. Entry files are pure re-export lists in both packages and
 * in `@leglas/server` behind them, so stopping at the first hop would describe
 * nothing at all.
 */
function collect(
  root: string,
  file: string,
  into: Map<string, string>,
  seen: Set<string>,
): void {
  if (seen.has(file)) return;
  seen.add(file);

  const source = declarations(file);
  for (const [name, text] of topLevelDeclarations(source)) {
    if (!into.has(name)) into.set(name, text);
  }

  const directory = file.slice(0, file.lastIndexOf("/"));
  for (const { from } of reexports(source)) {
    const next = moduleFile(root, directory, from);
    if (next !== null) collect(root, next, into, seen);
  }
}

/**
 * The surface as text, sorted by name, so reordering an export list is not a
 * diff and a real change is a small one a reviewer can read.
 */
export function publicSurface(root: string): string {
  const sections: string[] = [
    "# Public API surface",
    "#",
    "# Generated by `pnpm api:update`, from the built .d.ts. Do not edit by hand.",
    "# A change here changes what npm serves. See api-surface.ts.",
  ];

  for (const [packageName, packageDirectory] of ENTRIES) {
    const entryFile = join(root, packageDirectory, "dist", "index.d.ts");
    const entryDirectory = join(root, packageDirectory, "dist");
    const known = new Map<string, string>();
    collect(root, entryFile, known, new Set());

    const described = reexports(declarations(entryFile))
      .flatMap(({ names, from }) =>
        names.map((name) => {
          const text = known.get(name);
          if (text !== undefined) return { name, text };

          /**
           * Nowhere left to look. If the module was ours we read it, so the
           * name being absent means the reader failed rather than that the
           * declaration lives somewhere off the map. Refusing here is the
           * point: a silent gap in this file is a silent gap in the release
           * gate, and it would read as an ordinary limitation forever.
           */
          if (moduleFile(root, entryDirectory, from) !== null) {
            throw new Error(
              `${from} declares no ${name}, but it was read. api-surface.ts failed to parse it.`,
            );
          }
          return { name, text: `export ${name}; // from ${from}, not resolved` };
        }),
      )
      // By name, not by declaration text: sorting on the text would let a
      // changed signature move an entry, turning one edit into a shuffle.
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    sections.push("", `## ${packageName}`, "", ...described.map((entry) => entry.text));
  }

  return `${sections.join("\n")}\n`;
}

/**
 * `pnpm api:update` writes the snapshot. Running the module directly is the
 * whole entry point: the test imports the same function, so there is one
 * definition of the surface and no way for the writer and the checker to
 * disagree about what it is.
 */
if (import.meta.main) {
  const root = import.meta.dirname;
  writeFileSync(join(root, SNAPSHOT), publicSurface(root));
  process.stdout.write(`${SNAPSHOT} updated\n`);
}
