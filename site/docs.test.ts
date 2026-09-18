import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAssets } from "./chrome.ts";
import {
  PAGES,
  docsPath,
  loadDocs,
  parseBlocks,
  renderBlocks,
  renderDoc,
  resolveLink,
  slug,
  type DocPage,
} from "./docs.ts";

const root = join(import.meta.dirname, "..");
/** A checkout of the manual, with every page it names and nothing else. */
function manual(): string {
  const dir = mkdtempSync(join(tmpdir(), "leglas-docs-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(
    join(dir, "docs/README.md"),
    `# The manual\n\n${PAGES.map((page) => `- [${page}](${page}.md): a page.`).join("\n")}\n`,
  );
  for (const page of PAGES) writeFileSync(join(dir, `docs/${page}.md`), `# ${page}\n\nWords.\n`);
  return dir;
}

const pages = loadDocs(root);
const page = (name: string): DocPage => {
  const found = pages.find((candidate) => candidate.slug === name);
  if (found === undefined) throw new Error(`no docs page ${name}`);
  return found;
};

/**
 * The manual is read on GitHub and on the site from the same files, so the
 * page has to show every construct those files use and refuse one it would
 * pass through as source. These run against the real docs/ folder, which is
 * where a new construct would first appear.
 */
describe("docs/", () => {
  test("the index leads and the pages follow in the order the manual names them", () => {
    expect(pages[0]?.slug).toBe("");
    expect(pages.slice(1).map((entry) => entry.slug)).toEqual([
      "guide",
      "sharing",
      "configuration",
      "agents",
      "cli",
      "architecture",
    ]);
    expect(docsPath("")).toBe("docs/index.html");
    expect(docsPath("guide")).toBe("docs/guide/index.html");
  });

  /**
   * `docs/` is the public manual, but it is also where this repository's own
   * conventions put notes that are never committed: `docs/lessons.md` and
   * `docs/plans/`, both in `.git/info/exclude`. A reader that served every
   * markdown file it found turned those into pages of the manual in any
   * checkout that had them, which is every maintainer's.
   */
  test("a file the manual does not name is not one of its pages", () => {
    const dir = manual();
    writeFileSync(join(dir, "docs/lessons.md"), "# Lessons\n\nNot for anybody else.\n");
    mkdirSync(join(dir, "docs/plans"));
    writeFileSync(join(dir, "docs/plans/thing.md"), "# A plan\n\nLater.\n");

    expect(loadDocs(dir).map((entry) => entry.slug)).toEqual(["", ...PAGES]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a page the manual names and nobody wrote fails the build, naming it", () => {
    const dir = manual();
    rmSync(join(dir, "docs/sharing.md"));

    expect(() => loadDocs(dir)).toThrow("docs/sharing.md is named in the manual but not there");
    rmSync(dir, { recursive: true, force: true });
  });

  test("every page renders with nothing left as markdown", () => {
    const assets = loadAssets(root);
    for (const entry of pages) {
      const html = renderDoc(entry, pages, assets);
      expect(html).toContain(`<h1>${entry.title}</h1>`);
      // Strip code, where markdown characters are content, then look for source.
      const prose = html
        .replace(/<pre>[\s\S]*?<\/pre>/g, "")
        .replace(/<code>[\s\S]*?<\/code>/g, "");
      expect(prose, `${entry.file} leaks markdown`).not.toMatch(/\*\*|\]\(|^#{1,3} |^- |^\| /m);
    }
  });

  test("every link to another page resolves, fragment included", () => {
    const ids = new Map(
      pages.map((entry) => [
        entry.slug,
        new Set(
          parseBlocks(entry.markdown, entry.file).flatMap((block) =>
            block.kind === "heading" ? [slug(block.text)] : [],
          ),
        ),
      ]),
    );
    for (const entry of pages) {
      for (const match of entry.markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = match[1] ?? "";
        if (/^https?:/.test(href)) continue;
        const resolved = resolveLink(href, entry, pages);
        const [path, fragment] = resolved.split("#");
        if (path?.startsWith("https://")) continue;
        const target = (path ?? "").replace(/^(\.\.\/|\.\/)+/, "").replace(/\/$/, "");
        expect(
          target === "" || ids.has(target),
          `${entry.file} links ${href} which is not a page`,
        ).toBe(true);
        if (fragment !== undefined) {
          expect(
            ids.get(target)?.has(fragment),
            `${entry.file} links ${href} but the target has no such heading`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("links", () => {
  const index = page("");
  const guide = page("guide");

  test("another page becomes its directory, from the index and from a page", () => {
    expect(resolveLink("sharing.md", guide, pages)).toBe("../sharing/");
    expect(resolveLink("agents.md#running-requests", guide, pages)).toBe(
      "../agents/#running-requests",
    );
    expect(resolveLink("guide.md", index, pages)).toBe("./guide/");
    expect(resolveLink("README.md", guide, pages)).toBe("../");
  });

  test("the repository README is the homepage and the rest of the tree is on GitHub", () => {
    expect(resolveLink("../README.md", index, pages)).toBe("./../");
    expect(resolveLink("../README.md", guide, pages)).toBe("../../");
    expect(resolveLink("../CONTRIBUTING.md", index, pages)).toBe(
      "https://github.com/FredAmartey/leglas/blob/main/CONTRIBUTING.md",
    );
    expect(resolveLink("../packages/cli/src/bin.ts#L1", guide, pages)).toBe(
      "https://github.com/FredAmartey/leglas/blob/main/packages/cli/src/bin.ts#L1",
    );
  });

  test("absolute links and fragments pass through", () => {
    expect(resolveLink("https://leglas.vercel.app/changelog/", guide, pages)).toBe(
      "https://leglas.vercel.app/changelog/",
    );
    expect(resolveLink("#keys", guide, pages)).toBe("#keys");
  });
});

describe("the reader", () => {
  const fake: DocPage = { file: "x.md", slug: "x", title: "X", markdown: "" };
  const render = (markdown: string): string =>
    renderBlocks(parseBlocks(markdown, "x.md"), fake, pages);

  test("headings get GitHub's ids", () => {
    expect(slug("The rail and the stage")).toBe("the-rail-and-the-stage");
    expect(slug("Add beside, never rewrite")).toBe("add-beside-never-rewrite");
    expect(slug("What an agent runs")).toBe("what-an-agent-runs");
    expect(render("# T\n\n## MCP server\n")).toBe('<h2 id="mcp-server">MCP server</h2>');
  });

  test("paragraphs join their wrapped lines and carry inline markdown", () => {
    expect(render("# T\n\nOne line\nand the next, with `code` and **bold**.\n")).toBe(
      "<p>One line and the next, with <code>code</code> and <strong>bold</strong>.</p>",
    );
  });

  test("lists keep their continuation lines", () => {
    expect(render("# T\n\n- first item\n  continues here\n- second\n")).toBe(
      "<ul><li>first item continues here</li><li>second</li></ul>",
    );
  });

  test("numbered lists count from one and keep their continuation lines", () => {
    expect(render("# T\n\n1. first step\n   continues here\n2. second\n")).toBe(
      "<ol><li>first step continues here</li><li>second</li></ol>",
    );
    expect(render("# T\n\nA sentence.\n1. then a step\n")).toBe(
      "<p>A sentence.</p>\n<ol><li>then a step</li></ol>",
    );
    // GitHub starts the list at whatever number comes first and ignores the
    // rest, so anything but 1, 2, 3 would read differently there and here.
    expect(() => render("# T\n\n2. starts late\n")).toThrow(
      "x.md:3: a numbered list that does not count from 1",
    );
    expect(() => render("# T\n\n1. one\n3. three\n")).toThrow(
      "x.md:4: a numbered list that does not count from 1",
    );
  });

  test("code is escaped and keeps its language", () => {
    expect(render("# T\n\n```ts\nconst a = 1 < 2;\n```\n")).toBe(
      '<pre><code class="lang-ts">const a = 1 &lt; 2;</code></pre>',
    );
    expect(render("# T\n\n```\nplain\n```\n")).toBe("<pre><code>plain</code></pre>");
  });

  test("tables render a head and a body", () => {
    const html = render(
      "# T\n\n| Field | Purpose |\n| --- | --- |\n| `title` | Label in the rail |\n",
    );
    expect(html).toBe(
      "<table><thead><tr><th>Field</th><th>Purpose</th></tr></thead><tbody><tr><td><code>title</code></td><td>Label in the rail</td></tr></tbody></table>",
    );
  });

  test("a capture block is rebuilt from its images and caption", () => {
    const block =
      '<p align="center">\n  <img src="https://example.test/a.png" width="290" alt="A &amp; B" />\n</p>';
    expect(
      render(
        `# T\n\n<p align="center">\n  <img src="https://example.test/a.png" width="290" alt="A & B" />\n</p>\n\n<p align="center"><i>Caption.</i></p>\n`,
      ),
    ).toBe(`${block}\n<p align="center"><i>Caption.</i></p>`);
  });

  test("a capture block refuses anything outside that shape", () => {
    const wrap = (inner: string): string => `# T\n\n<p align="center">\n  ${inner}\n</p>\n`;
    expect(() =>
      render(wrap('<img src="https://example.test/a.png" alt="A" onerror="alert(1)" />')),
    ).toThrow("an image attribute this page cannot show");
    expect(() => render(wrap('<img src="javascript:alert(1)" alt="A" />'))).toThrow(
      "an image without an https source",
    );
    expect(() => render(wrap('<img src="https://example.test/a.png" />'))).toThrow(
      "an image without alt text",
    );
    expect(() =>
      render(wrap('<img src="https://example.test/a.png" alt="A" width="wide" />')),
    ).toThrow("an image width that is not a number");
    expect(() => render(wrap("<script>alert(1)</script>"))).toThrow(
      "a tag this page cannot show in a capture block",
    );
    expect(() => render(wrap("<i>Caption with <b>bold</b></i>"))).toThrow(
      "a tag this page cannot show in a capture block",
    );
    expect(() => render(wrap("loose text"))).toThrow("text outside an image or a caption");
    expect(() => render('# T\n\n<p class="x"><i>c</i></p>\n')).toThrow(
      "a capture block that is not a centred paragraph",
    );
    expect(() => render('# T\n\n<p align="center">\n</p>\n')).toThrow("an empty capture block");
  });

  test("a heading keeps its letters in any script and repeats get GitHub's suffix", () => {
    expect(slug("Über die Schiene")).toBe("über-die-schiene");
    expect(slug("What's `LEGLAS_NO_UPDATE_CHECK` for?")).toBe("whats-leglas_no_update_check-for");
    expect(render("# T\n\n## Keys\n\n## Keys\n\n## Keys\n")).toBe(
      '<h2 id="keys">Keys</h2>\n<h2 id="keys-1">Keys</h2>\n<h2 id="keys-2">Keys</h2>',
    );
  });

  test("a pipe escaped inside a cell stays in the cell", () => {
    expect(render("# T\n\n| a | b |\n| --- | --- |\n| `x \\| y` | z |\n")).toContain(
      "<td><code>x | y</code></td><td>z</td>",
    );
  });

  test("a line that starts with < is prose unless it opens a capture block", () => {
    expect(render("# T\n\nfinishes in\n< 5 minutes.\n")).toBe("<p>finishes in &lt; 5 minutes.</p>");
    expect(() => render("# T\n\n<div>raw</div>\n")).toThrow("HTML this page cannot show");
    expect(() => render('# T\n\n<p align="center">\n  <img src="x">\n')).toThrow(
      "a capture block that does not close",
    );
  });

  test("a stray angle bracket in a capture block refuses", () => {
    expect(() =>
      render(
        '# T\n\n<p align="center">\n  <img src="https://example.test/a.png" alt="A" /> >\n</p>\n',
      ),
    ).toThrow("a tag this page cannot show in a capture block");
  });

  test("an absolute path resolves from the repository root", () => {
    expect(resolveLink("/docs/agents.md#mcp-server", page("guide"), pages)).toBe(
      "../agents/#mcp-server",
    );
    expect(resolveLink("/SECURITY.md", page(""), pages)).toBe(
      "https://github.com/FredAmartey/leglas/blob/main/SECURITY.md",
    );
  });

  test("refuses markdown the page cannot show, naming the line", () => {
    expect(() => render("# T\n\n* a starred bullet\n")).toThrow(
      "x.md:3: markdown this page cannot show",
    );
    expect(() => render("# T\n\n1) a list GitHub would number\n")).toThrow(
      "x.md:3: markdown this page cannot show",
    );
    expect(() => render("# T\n\n> a quote\n")).toThrow("x.md:3");
    expect(() => render("# T\n\n```\nnever closed\n")).toThrow("a code fence that never closes");
    expect(() => render("# T\n\n| a | b |\n| c | d |\n")).toThrow("a table without a header rule");
    expect(() => render("# T\n\n# Again\n")).toThrow("a second title heading");
  });
});

describe("the page", () => {
  test("carries the bar with Docs active, the page nav and the way back", () => {
    const assets = loadAssets(root);
    const guide = renderDoc(page("guide"), pages, assets);
    expect(guide).toContain('<span class="active" aria-current="page">Docs</span>');
    expect(guide).toContain('href="../../changelog/"');
    expect(guide).toContain('<p class="eyebrow"><a href="../">Docs</a></p>');
    expect(guide).toContain('<a href="../sharing/">Sharing</a>');
    expect(guide).toContain('<span class="active" aria-current="page">Using Leglas</span>');
    expect(guide).toContain("docs/guide.md</a>.");
    const index = renderDoc(page(""), pages, assets);
    expect(index).toContain('href="./../changelog/"');
    expect(index).toContain('<a href="./guide/">Using Leglas</a>');
  });

  test("the homepage and the changelog link the docs", () => {
    const home = readFileSync(join(root, "site", "home.ts"), "utf8");
    expect(home).toContain('docs: "./docs/"');
    expect(home).toContain('href="./docs/"');
  });
});
