import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseChangelog } from "./changelog.ts";

export function releaseNotes(markdown: string, version: string): { title: string; body: string } | null {
  const headings = [...markdown.matchAll(/^## ([^\r\n]*)\r?$/gm)];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    const release = /^(.+?) \(\d{4}-\d{2}-\d{2}\): (.+)$/.exec(heading[1]!);
    if (release === null || !release[1]!.split(/\s+and\s+/).includes(version)) continue;
    // GitHub gets the authored markdown, including indentation and media.
    const start = heading.index + heading[0].length;
    return {
      title: release[2]!,
      body: markdown.slice(start, headings[i + 1]?.index ?? markdown.length).trim(),
    };
  }
  return null;
}

export function releasesIndex(markdown: string): { version: string; date: string; title: string }[] {
  return parseChangelog(markdown).entries.flatMap((entry) => {
    if (entry.date === null || entry.title === null || entry.versions.includes("Unreleased")) return [];
    const { date, title } = entry;
    // Shared headings list the earlier version first; the feed leads with the later one.
    return entry.versions.toReversed().map((version) => ({ version, date, title }));
  }).sort((a, b) => b.date.localeCompare(a.date));
}

if (import.meta.main) {
  const version = process.argv[2] ?? "(missing version)";
  const notes = releaseNotes(readFileSync(join(import.meta.dirname, "CHANGELOG.md"), "utf8"), version);
  if (notes === null) {
    process.stderr.write(`No changelog entry for ${version}.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${process.argv.includes("--title") ? notes.title : notes.body}\n`);
  }
}
