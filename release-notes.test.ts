import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { releaseNotes, releasesIndex } from "./release-notes.ts";

const markdown = [
  "# Changelog", "", "## Unreleased", "", "- Still in progress.", "",
  "## 1.0.0 (2026-09-06): Share the rail", "", "An introduction.", "", "### Added", "",
  "- **Sharing.** Keep the `raw` markdown.", "  Keep this indent too.", "",
  "![A rail](rail.png)", "",
  "## 0.7.1 and 0.7.2 (2026-08-28): Two releases", "", "### Fixed", "", "- The fix.", "",
  "## 0.7.0 (2026-08-27): An earlier release", "", "- Earlier work.", "",
].join("\n");

describe("releaseNotes", () => {
  test("returns the title and exact markdown until the next release heading", () => {
    expect(releaseNotes(markdown, "1.0.0")).toEqual({
      title: "Share the rail",
      body: "An introduction.\n\n### Added\n\n- **Sharing.** Keep the `raw` markdown.\n  Keep this indent too.\n\n![A rail](rail.png)",
    });
  });

  test.each(["0.7.1", "0.7.2"])("matches %s in a shared heading", (version) => {
    expect(releaseNotes(markdown, version)).toEqual({ title: "Two releases", body: "### Fixed\n\n- The fix." });
  });

  test("reads the last entry and returns null for absent or partial versions", () => {
    expect(releaseNotes(markdown, "0.7.0")?.body).toBe("- Earlier work.");
    expect(releaseNotes(markdown, "7.0")).toBeNull();
    expect(releaseNotes(markdown, "9.0.0")).toBeNull();
    expect(releaseNotes(markdown, "Unreleased")).toBeNull();
  });

  test("handles Windows line endings without rewriting the body", () => {
    expect(releaseNotes(markdown.replaceAll("\n", "\r\n"), "0.7.1")?.body).toBe("### Fixed\r\n\r\n- The fix.");
  });

  test("the real 1.0.0 entry has a title and a body", () => {
    const notes = releaseNotes(readFileSync(join(import.meta.dirname, "CHANGELOG.md"), "utf8"), "1.0.0");
    expect(notes?.title).toBe("Share the rail with someone who has no repo");
    expect(notes?.body).toContain("### Added");
    expect(notes?.body).toContain("**Share what is on your rail with someone who has no repo.**");
    expect(notes?.body).not.toMatch(/^## /m);
  });
});

describe("releasesIndex", () => {
  test("lists each released version newest first without Unreleased", () => {
    expect(releasesIndex(markdown)).toEqual([
      { version: "1.0.0", date: "2026-09-06", title: "Share the rail" },
      { version: "0.7.2", date: "2026-08-28", title: "Two releases" },
      { version: "0.7.1", date: "2026-08-28", title: "Two releases" },
      { version: "0.7.0", date: "2026-08-27", title: "An earlier release" },
    ]);
  });
});

describe("release-notes.ts command", () => {
  const script = join(import.meta.dirname, "release-notes.ts");
  const notes = releaseNotes(readFileSync(join(import.meta.dirname, "CHANGELOG.md"), "utf8"), "1.0.0")!;

  test.each([[[], "body"], [["--title"], "title"]] as const)("prints %s from any working directory", (flags, key) => {
    const result = spawnSync(process.execPath, [script, "1.0.0", ...flags], { encoding: "utf8", cwd: tmpdir() });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${notes[key]}\n`);
  });

  test("a missing version exits with the specified sentence", () => {
    const result = spawnSync(process.execPath, [script, "99.0.0"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("No changelog entry for 99.0.0.\n");
  });
});
