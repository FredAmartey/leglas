import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_LOG_DIR, loadConfig } from "@leglas/server";

export type LogDeps = { log(line: string): void; error(line: string): void };

/** An entry's own first line, which is its title, without opening the whole file. */
function headline(markdown: string): string {
  const first = markdown.split("\n", 1)[0] ?? "";
  return first.replace(/^#\s*/, "").trim();
}

/**
 * Read what past explorations decided.
 *
 * The entries are plain markdown in a committed directory and are meant to be
 * read that way, in a pull request or on GitHub. This exists because an agent
 * asked to work on a surface should be able to find what was already tried
 * there without being told where to look, and because a person coming back to
 * a project should not have to know the directory's name.
 */
export async function runLog(
  options: { entry: string | null; json: boolean; cwd: string },
  deps: LogDeps,
): Promise<{ exitCode: number }> {
  const loaded = await loadConfig(options.cwd);
  const dir = loaded.config?.logDir ?? DEFAULT_LOG_DIR;

  let names: string[];
  try {
    names = (await readdir(join(options.cwd, dir)))
      .filter((name) => name.endsWith(".md"))
      // The slug leads with the date, so lexical order is chronological.
      .sort()
      .reverse();
  } catch {
    names = [];
  }

  if (options.entry !== null) {
    const wanted = options.entry.replace(/\.md$/, "");
    const found = names.find((name) => name === `${wanted}.md`);
    if (found === undefined) {
      const error = `No entry called ${JSON.stringify(options.entry)} in ${dir}.`;
      if (options.json) deps.log(JSON.stringify({ ok: false, error }));
      else deps.error(error);
      return { exitCode: 1 };
    }
    const markdown = await readFile(join(options.cwd, dir, found), "utf8");
    if (options.json) deps.log(JSON.stringify({ ok: true, entry: wanted, markdown }));
    else deps.log(markdown.trimEnd());
    return { exitCode: 0 };
  }

  const entries = await Promise.all(
    names.map(async (name) => ({
      entry: name.replace(/\.md$/, ""),
      title: headline(await readFile(join(options.cwd, dir, name), "utf8")),
      file: `${dir}/${name}`,
    })),
  );

  if (options.json) {
    deps.log(JSON.stringify({ ok: true, dir, entries }));
    return { exitCode: 0 };
  }

  if (entries.length === 0) {
    deps.log(`  No decisions recorded yet. One is written each time you run leglas keep.`);
    return { exitCode: 0 };
  }

  const width = Math.max(...entries.map((entry) => entry.entry.length));
  for (const entry of entries) deps.log(`  ${entry.entry.padEnd(width)}  ${entry.title}`);
  return { exitCode: 0 };
}
