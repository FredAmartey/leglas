import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** One direction a switch file lists: its key in the URL, its component and where that is imported from. */
export type SwitchDirection = { key: string; name: string; from: string };

export type Slot = { key: string; name: string };

const MAP = /const DIRECTIONS = \{([\s\S]*?)\} as const;/;

const SOURCE = /\.(tsx|jsx|ts|js)$/;

/** Far enough to reach a component folder, short enough that a monorepo cannot keep the walk going. */
const SCAN_LIMIT = 3000;

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a surface's switch file is, relative to the project.
 *
 * `leglas new` puts it in `.leglas/variants/<slug>/`, but a project may keep
 * it with its components, so the fallback is the source file that both lists
 * directions and reads the surface's query parameter.
 */
export async function findSwitch(cwd: string, slug: string): Promise<string | null> {
  for (const name of ["switch.tsx", "switch.jsx"]) {
    const path = join(".leglas", "variants", slug, name);

    if (await isFile(join(cwd, path))) return path;
  }

  const wanted = `"v-${slug}"`;
  let seen = 0;

  const walk = async (folder: string): Promise<string | null> => {
    let items;

    try {
      items = await readdir(join(cwd, folder), { withFileTypes: true });
    } catch {
      return null;
    }

    for (const item of items) {
      if (seen >= SCAN_LIMIT || item.name.startsWith(".") || item.name === "node_modules") continue;
      const path = join(folder, item.name);

      if (item.isDirectory()) {
        const found = await walk(path);

        if (found !== null) return found;
        continue;
      }

      if (!SOURCE.test(item.name)) continue;
      seen += 1;
      const source = await readFile(join(cwd, path), "utf8").catch(() => "");

      if (source.includes(wanted) && MAP.test(source)) return path;
    }

    return null;
  };

  for (const root of ["src", "app"]) {
    const found = await walk(root);

    if (found !== null) return relative(cwd, join(cwd, found));
  }

  return null;
}

/** The directions a switch file lists, each with the import its component comes from. */
export function readDirections(source: string): SwitchDirection[] {
  const imports = new Map<string, string>();

  for (const match of source.matchAll(/^import \{ (\w+) \} from "([^"]+)";$/gm)) {
    imports.set(match[1] ?? "", match[2] ?? "");
  }

  const body = MAP.exec(source)?.[1] ?? "";
  const directions: SwitchDirection[] = [];

  for (const match of body.matchAll(/"?([\w-]+)"?\s*:\s*(\w+)/g)) {
    const key = match[1] ?? "";
    const name = match[2] ?? "";
    const from = imports.get(name);

    if (from !== undefined) directions.push({ key, name, from });
  }

  return directions;
}

/** Every key a switch's DIRECTIONS map holds, however its components are imported. */
export function directionKeys(source: string): string[] {
  const body = MAP.exec(source)?.[1] ?? "";

  return [...body.matchAll(/"?([\w-]+)"?\s*:/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** The direction a switch shows when the URL names none. */
export function fallbackKey(source: string): string | null {
  return /const FALLBACK: \w+ = "([\w-]+)";/.exec(source)?.[1] ?? null;
}

/**
 * The switch file with one import and one `DIRECTIONS` entry added per slot.
 *
 * Existing directions stay, in their order: a generation adds to a surface,
 * it never takes over one.
 */
export function addSlots(source: string, slots: readonly Slot[]): string {
  if (!MAP.test(source)) throw new Error("The switch file has no DIRECTIONS map.");
  const lines = source.split("\n");
  let last = -1;

  lines.forEach((line, index) => {
    if (line.startsWith("import ")) last = index;
  });

  lines.splice(
    last + 1,
    0,
    ...slots.map((slot) => `import { ${slot.name} } from "./${slot.key}";`),
  );
  const added = slots.map((slot) => `  "${slot.key}": ${slot.name},`).join("\n");

  return lines
    .join("\n")
    .replace(
      MAP,
      (_, body: string) =>
        `const DIRECTIONS = {\n${body.replace(/^\s*\n|\s+$/g, "").replace(/,?$/, ",")}\n${added}\n} as const;`,
    );
}

/** What a slot renders while its build runs: nothing, so no half-finished design is ever on show. */
export function placeholderSource(name: string): string {
  return `export function ${name}() {\n  return null;\n}\n`;
}
