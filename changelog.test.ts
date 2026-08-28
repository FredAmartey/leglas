import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { anchor, inline, longDate, parseChangelog, renderPage } from "./changelog.ts";
import { loadAssets } from "./chrome.ts";

const root = import.meta.dirname;

/**
 * The page is made from CHANGELOG.md and nothing else, so the file has to
 * hold what the page shows: a date and a title on every release heading, and
 * bullets whose audience tag names one of the three things a release ships.
 * A slip here is cheapest in the pull request that made it, which is where
 * this runs.
 */
describe("CHANGELOG.md", () => {
  const changelog = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const released = changelog.entries.filter((entry) => entry.versions[0] !== "Unreleased");

  test("every release heading carries a date and a title", () => {
    expect(released.length).toBeGreaterThan(0);
    for (const entry of released) {
      const name = entry.versions.join(" and ");
      expect(entry.date, `${name} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        entry.title,
        `${name} has no title. Write one into the heading: "## ${name} (${entry.date}): What it is about".`,
      ).toBeTruthy();
    }
  });

  test("the newest release is the one the packages declare", () => {
    const first = changelog.entries[0]!;
    if (first.versions[0] === "Unreleased") return;
    const declared = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
    // An entry can name two releases, as the first one does.
    expect(first.versions, "the top entry is not the version being shipped").toContain(declared);
  });

  test("releases run newest first, and none repeats", () => {
    const seen = new Set<string>();
    for (const entry of released) {
      for (const version of entry.versions) {
        expect(seen.has(version), `${version} appears twice`).toBe(false);
        seen.add(version);
      }
    }
    const dates = released.map((entry) => entry.date!);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test("renders as one page with an anchor for every release", () => {
    const html = renderPage(changelog, loadAssets(root));
    for (const entry of changelog.entries) expect(html).toContain(`id="${anchor(entry)}"`);
    expect(html).toContain("@font-face");
    expect(html).toContain('class="mark"');
    expect(html).toContain('class="wordmark"');
    expect(html).not.toContain("<style>\n    .wm");
  });
});

describe("reading the markdown", () => {
  test("a bullet keeps its bold lead, its text and who it reaches", () => {
    const { entries } = parseChangelog(
      ["## 1.0.0 (2026-01-02): A title", "", "### Added", "", "- **The lead.** The rest of it. (`leglas`, plugin)", ""].join("\n"),
    );
    const group = entries[0]!.blocks[0]!;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.heading).toBe("Added");
    expect(group.blocks[0]).toEqual({
      kind: "item",
      lead: "The lead.",
      text: "The rest of it.",
      more: [],
      reaches: ["cli", "plugin"],
    });
    expect(entries[0]).toMatchObject({ versions: ["1.0.0"], date: "2026-01-02", title: "A title" });
  });

  test("a blank line inside a bullet starts a paragraph rather than ending the list", () => {
    const { entries } = parseChangelog(
      [
        "## 1.0.0 (2026-01-02): A title",
        "",
        "### Fixed",
        "",
        "- **First.** Continues",
        "  on the next line.",
        "",
        "  A second paragraph, still the same bullet. (`leglas-mcp`)",
        "",
        "- **Second.** Another bullet.",
        "",
      ].join("\n"),
    );
    const group = entries[0]!.blocks[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.blocks).toHaveLength(2);
    expect(group.blocks[0]).toMatchObject({
      text: "Continues on the next line.",
      more: ["A second paragraph, still the same bullet."],
      reaches: ["mcp"],
    });
    expect(group.blocks[1]).toMatchObject({ lead: "Second.", text: "Another bullet.", reaches: [] });
  });

  test("an image line with a caption becomes media, inside its group", () => {
    const { entries } = parseChangelog(
      ["## 1.0.0 (2026-01-02): A title", "", "### Added", "", "- A bullet.", "", '![The rail](rail.png "Two directions, side by side.")', ""].join(
        "\n",
      ),
    );
    const group = entries[0]!.blocks[0]!;
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.blocks[1]).toEqual({ kind: "media", src: "rail.png", alt: "The rail", caption: "Two directions, side by side." });
  });

  test("an Unreleased section and a two-version heading both read", () => {
    const { entries } = parseChangelog(
      ["## Unreleased", "", "- Something.", "", "## 0.1.0 and 0.1.1 (2026-08-01): First release", "", "Words.", ""].join("\n"),
    );
    expect(entries[0]).toMatchObject({ versions: ["Unreleased"], date: null, title: null });
    expect(anchor(entries[0]!)).toBe("unreleased");
    expect(entries[1]).toMatchObject({ versions: ["0.1.0", "0.1.1"], date: "2026-08-01", title: "First release" });
    expect(anchor(entries[1]!)).toBe("v0.1.0");
  });

  test("an audience nobody ships is refused", () => {
    expect(() => parseChangelog("## 1.0.0 (2026-01-02): T\n\n- Words. (`legless`)\n")).toThrow(/Unknown audience/);
  });

  test("a tag that does not end its bullet is refused rather than left in the prose", () => {
    expect(() => parseChangelog("## 1.0.0 (2026-01-02): T\n\n- Words. (`leglas`).\n")).toThrow(/ends its bullet/);
    expect(() => parseChangelog("## 1.0.0 (2026-01-02): T\n\n- Words (`leglas`) and more.\n")).toThrow(/ends its bullet/);
    // A parenthetical of commands is prose, not a tag.
    expect(parseChangelog("## 1.0.0 (2026-01-02): T\n\n- Asked (`claude auth status`, `codex login status`) first. (`leglas`)\n").entries[0]!.blocks[0]).toMatchObject({ reaches: ["cli"] });
  });

  test("a paragraph that lost its indent inside a group is refused", () => {
    expect(() =>
      parseChangelog(["## 1.0.0 (2026-01-02): T", "", "### Fixed", "", "- **Lead.** Words.", "", "A second paragraph, unindented.", ""].join("\n")),
    ).toThrow(/Indent it by two spaces/);
    // Above the group, at the entry's level, prose is the intro and stays allowed.
    expect(parseChangelog(["## 1.0.0 (2026-01-02): T", "", "- A bullet.", "", "Then prose.", ""].join("\n")).entries[0]!.blocks).toHaveLength(2);
  });

  test("a bullet inside a bullet is refused", () => {
    expect(() => parseChangelog("## 1.0.0 (2026-01-02): T\n\n- Outer.\n  - Inner.\n")).toThrow(/bullet inside a bullet/);
  });

  test("inline code, bold and links, with everything else escaped", () => {
    expect(inline("Run `a <b>` **now** and [read](https://x.y/z?a=1&b=2) it")).toBe(
      'Run <code>a &lt;b&gt;</code> <strong>now</strong> and <a href="https://x.y/z?a=1&amp;b=2">read</a> it',
    );
    expect(inline("**`.leglas/server.json`** records")).toBe("<strong><code>.leglas/server.json</code></strong> records");
  });

  test("a width hint on an image sizes the figure and leaves the URL", () => {
    const html = renderPage(
      parseChangelog(["## 1.0.0 (2026-01-02): T", "", '![The picker](https://x.y/picker.png#w=500 "Open.")', ""].join("\n")),
      loadAssets(root),
    );
    expect(html).toContain('<figure class="media" style="max-width:500px"><img src="https://x.y/picker.png"');
    expect(html).toContain("<figcaption>Open.</figcaption>");
  });

  test("a lead keeps its distance from a sentence and none from a comma", () => {
    const html = renderPage(
      parseChangelog(
        ["## 1.0.0 (2026-01-02): T", "", "- **`leglas`**, the tool", "- **Lead.** Then words.", "- **Alone.**", ""].join("\n"),
      ),
      loadAssets(root),
    );
    expect(html).toContain("<strong class=\"lead\"><code>leglas</code></strong>, the tool");
    expect(html).toContain("<strong class=\"lead\">Lead.</strong> Then words.");
    expect(html).toContain("<strong class=\"lead\">Alone.</strong></span>");
  });

  test("a date reads the way a person says it", () => {
    expect(longDate("2026-08-28")).toBe("Aug 28, 2026");
    expect(longDate("2026-01-02")).toBe("Jan 2, 2026");
  });
});
