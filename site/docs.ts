import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { inline } from "./changelog.ts";
import { REPO, bar, document, escape, foot, promptButton, type Assets } from "./chrome.ts";

/**
 * docs/*.md, as pages, so GitHub and the site show one text. Reads only the
 * markdown these files use (headings, paragraphs, bullet and numbered lists,
 * fenced code, tables, centred capture blocks); anything else fails the build
 * instead of rendering as source.
 */

export type DocPage = {
  /** The file under docs/, README.md for the index. */
  file: string;
  /** The directory under /docs/ the page is served from; "" for the index. */
  slug: string;
  title: string;
  markdown: string;
};

/**
 * The manual, in site order. Named rather than read from the folder, because
 * `docs/lessons.md` and `docs/plans/` are local notes beside it, and serving
 * them would fail this suite in any maintainer's checkout while CI, with only
 * committed files, passes. A name here with no file stops the build;
 * `test/docs.test.ts` checks, against git, that no committed page is missing.
 */
export const PAGES = [
  "guide",
  "sharing",
  "configuration",
  "agents",
  "cli",
  "architecture",
] as const;

export function loadDocs(root: string): DocPage[] {
  const dir = join(root, "docs");

  const read = (file: string): DocPage => {
    const path = join(dir, file);

    if (!existsSync(path)) throw new Error(`docs/${file} is named in the manual but not there.`);
    const markdown = readFileSync(path, "utf8");
    const heading = markdown.split("\n").find((line) => line.startsWith("# "));

    if (heading === undefined) throw new Error(`docs/${file} has no title heading.`);

    return {
      file,
      slug: file === "README.md" ? "" : file.slice(0, -".md".length),
      title: heading.slice(2).trim(),
      markdown,
    };
  };

  return [read("README.md"), ...PAGES.map((page) => read(`${page}.md`))];
}

/** Where a page is written under the site, so build.ts and the tests agree. */
export function docsPath(slug: string): string {
  return slug === "" ? posix.join("docs", "index.html") : posix.join("docs", slug, "index.html");
}

export type Block =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "html"; text: string }
  | { kind: "details"; summary: string; text: string };

/**
 * A page's body after the title heading, as blocks. A line this reader doesn't
 * know is an error with file and line, since the alternative is a page showing
 * markdown.
 */
export function parseBlocks(markdown: string, file: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];

  const refuse = (index: number, why: string): never => {
    throw new Error(`docs/${file}:${index + 1}: ${why}: "${lines[index]}"`);
  };

  let i = 0;
  let titled = false;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
    } else if (line.startsWith("# ")) {
      if (titled) refuse(i, "a second title heading");
      titled = true;
      i += 1;
    } else if (line.startsWith("## ") || line.startsWith("### ")) {
      const level = line.startsWith("## ") ? 2 : 3;
      blocks.push({ kind: "heading", level, text: line.slice(level + 1).trim() });
      i += 1;
    } else if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;

      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }

      if (i >= lines.length) refuse(i - 1, "a code fence that never closes");
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      i += 1;
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];

      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        rows.push(cells(lines[i] ?? ""));
        i += 1;
      }

      const [head, rule, ...body] = rows;

      if (
        head === undefined ||
        rule === undefined ||
        !rule.every((cell) => /^:?-+:?$/.test(cell))
      ) {
        refuse(i - rows.length, "a table without a header rule");
      }

      blocks.push({ kind: "table", head: head ?? [], rows: body });
    } else if (line.startsWith("- ")) {
      const items: string[] = [];

      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        let item = (lines[i] ?? "").slice(2);
        i += 1;

        while (i < lines.length && (lines[i] ?? "").startsWith("  ")) {
          item += ` ${(lines[i] ?? "").trim()}`;
          i += 1;
        }

        items.push(item);
      }

      blocks.push({ kind: "list", ordered: false, items });
    } else if (/^\d+\. /.test(line)) {
      // GitHub numbers a list from its first item and ignores the rest, so only
      // 1, 2, 3 reads the same in both places.
      const items: string[] = [];

      while (i < lines.length && /^\d+\. /.test(lines[i] ?? "")) {
        const [, number = "", rest = ""] = /^(\d+)\. (.*)$/.exec(lines[i] ?? "") ?? [];

        if (Number(number) !== items.length + 1)
          refuse(i, "a numbered list that does not count from 1");
        let item = rest;
        i += 1;

        while (i < lines.length && (lines[i] ?? "").startsWith("  ")) {
          item += ` ${(lines[i] ?? "").trim()}`;
          i += 1;
        }

        items.push(item);
      }

      blocks.push({ kind: "list", ordered: true, items });
    } else if (CAPTURE.test(line)) {
      // The centred capture blocks, the only HTML the docs use. Rebuilt from an
      // allowlist, not copied, so a block is this shape or a build error.
      const start = i;
      const html: string[] = [];

      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        html.push(lines[i] ?? "");
        i += 1;
      }

      blocks.push({
        kind: "html",
        text: captureBlock(html.join("\n"), (why) => refuse(start, why)),
      });
    } else if (line.trim() === "<details>") {
      // A collapsible block: one summary line, then capture blocks, rebuilt the
      // same way.
      const start = i;
      let summary: string | undefined;
      const inner: string[] = [];
      i += 1;

      while (i < lines.length && (lines[i] ?? "").trim() !== "</details>") {
        const current = (lines[i] ?? "").trim();

        if (current === "") {
          i += 1;
        } else if (summary === undefined) {
          const match = /^<summary>([^<>]*)<\/summary>$/.exec(current);

          summary =
            match === null
              ? refuse(
                  i,
                  current.startsWith("<summary>")
                    ? "a summary this page cannot show"
                    : "a details block without a summary",
                )
              : (match[1] ?? "");
          i += 1;
        } else if (CAPTURE.test(current)) {
          const from = i;
          const html: string[] = [];

          while (i < lines.length && !["", "</details>"].includes((lines[i] ?? "").trim())) {
            html.push(lines[i] ?? "");
            i += 1;
          }

          inner.push(captureBlock(html.join("\n"), (why) => refuse(from, why)));
        } else {
          refuse(i, "a details block may hold only a summary and capture blocks");
        }
      }

      if (i >= lines.length) refuse(start, "a details block that does not close");

      const title = summary ?? refuse(start, "a details block without a summary");

      if (inner.length === 0) refuse(start, "an empty details block");

      i += 1;
      blocks.push({ kind: "details", summary: title, text: inner.join("\n") });
    } else if (/^<[a-zA-Z!/]/.test(line)) {
      refuse(i, "HTML this page cannot show");
    } else if (/^(>|\*|\+|#{4,}|\d+\))\s/.test(line) || /^(---|\*\*\*)\s*$/.test(line)) {
      refuse(i, "markdown this page cannot show");
    } else {
      const text: string[] = [];

      while (
        i < lines.length &&
        (lines[i] ?? "").trim() !== "" &&
        !/^(#{1,3} |```|\||- |1\. )/.test(lines[i] ?? "") &&
        !CAPTURE.test(lines[i] ?? "")
      ) {
        text.push((lines[i] ?? "").trim());
        i += 1;
      }

      blocks.push({ kind: "paragraph", text: text.join(" ") });
    }
  }

  return blocks;
}

/** A capture block opens with a paragraph tag; the docs centre their images that way. */
const CAPTURE = /^<p[\s>]/;

/**
 * The one HTML shape the docs use: a centred paragraph of images, or an italic
 * caption. Parsed and written back from its values, so no other attribute or
 * tag reaches the page.
 */
export function captureBlock(text: string, refuse: (why: string) => never): string {
  const match = /^<p align="center">([\s\S]*)<\/p>\s*$/.exec(text);

  if (match === null) {
    if (!/<\/p>\s*$/.test(text)) refuse("a capture block that does not close");

    return refuse("a capture block that is not a centred paragraph");
  }

  const parts: string[] = [];
  const inner = match[1] ?? "";
  const token = /<img\b([^<>]*?)\s*\/?>|<i>([^<>]*)<\/i>|([^<>]+)|([<>])/g;

  for (const piece of inner.matchAll(token)) {
    const [, image, caption, prose, stray] = piece;

    if (image !== undefined) {
      // Attributes are read in order until nothing is left; a bare word, an
      // unquoted value or a second form of quoting is a refusal, not a skip.
      const attributes = new Map<string, string>();
      let rest = image.trim();

      while (rest !== "") {
        const attribute = /^([a-z]+)="([^"<>]*)"\s*/.exec(rest);

        if (attribute === null) return refuse("an image attribute this page cannot show");
        attributes.set(attribute[1] ?? "", attribute[2] ?? "");
        rest = rest.slice(attribute[0].length);
      }

      const src = attributes.get("src");
      const width = attributes.get("width");
      const alt = attributes.get("alt");

      for (const name of attributes.keys())
        if (!["src", "width", "alt"].includes(name))
          refuse(`an image attribute this page cannot show: ${name}`);

      if (src === undefined || !src.startsWith("https://"))
        refuse("an image without an https source");

      if (width !== undefined && !/^\d+$/.test(width))
        refuse("an image width that is not a number");

      if (alt === undefined) refuse("an image without alt text");
      parts.push(
        `<img src="${escape(src)}"${width === undefined ? "" : ` width="${width}"`} alt="${escape(alt)}" />`,
      );
    } else if (caption !== undefined) {
      parts.push(`<i>${escape(caption)}</i>`);
    } else if (prose !== undefined) {
      if (prose.trim() !== "") refuse("text outside an image or a caption in a capture block");
    } else if (stray !== undefined) {
      refuse("a tag this page cannot show in a capture block");
    }
  }

  if (parts.length === 0) refuse("an empty capture block");

  return parts.length === 1 && parts[0]?.startsWith("<i>")
    ? `<p align="center">${parts[0]}</p>`
    : `<p align="center">\n  ${parts.join("\n  ")}\n</p>`;
}

/** Cells split on pipes that are not escaped, the way GitHub reads `\|` inside a cell. */
function cells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** GitHub's heading ids, so a link written for the repository resolves on the site too. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * A GitHub link resolved for the site: another manual page becomes its
 * directory, the README the homepage, and anything else in the tree points at
 * GitHub. Absolute links and fragments pass through.
 */
export function resolveLink(href: string, page: DocPage, pages: DocPage[]): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const hash = href.indexOf("#");
  const [path, fragment] = hash === -1 ? [href, ""] : [href.slice(0, hash), href.slice(hash)];
  const up = page.slug === "" ? "./" : "../";
  const inTree = posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join("docs", path));

  if (inTree.startsWith("docs/")) {
    const target = pages.find((candidate) => `docs/${candidate.file}` === inTree);

    if (target !== undefined)
      return `${up}${target.slug === "" ? "" : `${target.slug}/`}${fragment}`;
  }

  if (inTree === "README.md") return `${up}../${fragment}`;

  return `${REPO}/blob/main/${inTree}${fragment}`;
}

/**
 * The first ```prompt block in the section a link's fragment names on another
 * docs page. On the site the link becomes a copy button; on GitHub it stays a
 * link.
 */
export function promptFor(href: string, pages: DocPage[]): string | undefined {
  const hash = href.indexOf("#");

  if (/^(https?:|mailto:|#)/.test(href) || hash === -1) return undefined;

  const path = href.slice(0, hash);
  const inTree = posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join("docs", path));
  const target = pages.find((candidate) => `docs/${candidate.file}` === inTree);

  if (target === undefined) return undefined;

  const fragment = href.slice(hash + 1);
  const seen = new Map<string, number>();
  let inSection = false;

  // Ids repeat as renderBlocks writes them ("setup-1" for a second "Setup"), so
  // a link to either finds its prompt.
  for (const block of parseBlocks(target.markdown, target.file)) {
    if (block.kind === "heading") {
      const base = slug(block.text);
      const count = seen.get(base) ?? 0;

      seen.set(base, count + 1);
      inSection = (count === 0 ? base : `${base}-${count}`) === fragment;
    } else if (inSection && block.kind === "code" && block.lang === "prompt") return block.text;
  }

  return undefined;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function renderBlocks(blocks: Block[], page: DocPage, pages: DocPage[]): string {
  const text = (markdown: string): string => {
    // A link to a prompt block becomes a button, via a marker the inline pass
    // leaves alone.
    const buttons: string[] = [];

    const marked = markdown.replace(LINK, (_, label: string, href: string) => {
      const prompt = promptFor(href, pages);

      if (prompt === undefined) return `[${label}](${resolveLink(href, page, pages)})`;
      buttons.push(promptButton(inline(label), prompt));

      return `\uE000${buttons.length - 1}\uE000`;
    });

    return inline(marked).replace(
      /\uE000(\d+)\uE000/g,
      (_, index: string) => buttons[Number(index)] ?? "",
    );
  };

  const html: string[] = [];
  const seen = new Map<string, number>();

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const base = slug(block.text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        html.push(`<h${block.level} id="${id}">${text(block.text)}</h${block.level}>`);
        break;
      }

      case "paragraph":
        html.push(`<p>${text(block.text)}</p>`);
        break;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        html.push(
          `<${tag}>${block.items.map((item) => `<li>${text(item)}</li>`).join("")}</${tag}>`,
        );
        break;
      }

      case "code": {
        const pre = `<pre><code${block.lang ? ` class="lang-${escape(block.lang)}"` : ""}>${escape(block.text)}</code></pre>`;

        html.push(
          block.lang === "prompt"
            ? `${pre}\n<p>${promptButton("Copy this prompt", block.text)}</p>`
            : pre,
        );
        break;
      }

      case "table":
        html.push(
          `<table><thead><tr>${block.head.map((cell) => `<th>${text(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${text(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        );
        break;
      case "html":
        html.push(block.text);
        break;
      case "details":
        html.push(
          `<details><summary>${escape(block.summary)}</summary>\n${block.text}\n</details>`,
        );
        break;
    }
  }

  return html.join("\n");
}

const STYLES = `
.page{position:relative;z-index:1;max-width:980px;margin:0 auto;padding:96px 28px 80px}
.head{display:flex;flex-direction:column;gap:10px;margin-bottom:28px}
.eyebrow{margin:0;font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.eyebrow a{color:inherit;text-decoration:none}
.eyebrow a:hover{color:var(--ink)}
h1{margin:0;font-size:56px;font-weight:500;letter-spacing:-.03em;line-height:1.05;text-wrap:balance}
.pages{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0 0 44px;padding:14px 0;border-top:1px dotted var(--rule);border-bottom:1px dotted var(--rule);font-size:14px;letter-spacing:-.01em}
.pages a{color:var(--ink-3);text-decoration:none}
.pages a:hover{color:var(--ink)}
.pages .active{color:var(--ink);font-weight:500}
.doc{max-width:720px;font-size:17px;line-height:1.6;color:var(--ink-2);letter-spacing:-.01em}
.doc h2{margin:44px 0 12px;font-size:26px;font-weight:500;letter-spacing:-.025em;line-height:1.2;color:var(--ink);text-wrap:balance}
.doc h3{margin:32px 0 8px;font-size:19px;font-weight:500;letter-spacing:-.015em;color:var(--ink)}
.doc h2:first-child{margin-top:0}
.doc p{margin:0 0 14px}
.doc ul,.doc ol{margin:0 0 14px;padding-left:20px}
.doc li+li{margin-top:6px}
.doc details{margin:0 0 14px;border-top:1px dotted var(--rule);border-bottom:1px dotted var(--rule)}
.doc summary{display:flex;align-items:center;gap:10px;padding:12px 0;cursor:pointer;list-style:none;font-weight:500;color:var(--ink)}
.doc summary::-webkit-details-marker{display:none}
.doc summary::before{content:"";flex:none;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s ease}
.doc details[open] summary::before{transform:rotate(45deg)}
.doc details[open] summary{margin-bottom:4px}
.doc li::marker{color:var(--ink-4)}
.doc a{text-decoration:underline;text-decoration-color:var(--ink-4);text-underline-offset:3px}
.doc a:hover{text-decoration-color:currentColor}
.doc strong{color:var(--ink);font-weight:500}
.doc pre{margin:0 0 16px;padding:14px 16px;border:1px solid var(--rule);border-radius:10px;background:var(--code-bg);overflow:auto;font-family:var(--mono);font-size:13.5px;line-height:1.55}
.doc pre code{background:none;padding:0;font-size:inherit}
.doc table{width:100%;border-collapse:collapse;margin:4px 0 20px;font-size:15px;line-height:1.5}
.doc th,.doc td{padding:9px 10px 9px 0;border-top:1px dotted var(--rule);text-align:left;vertical-align:top}
.doc th{border-top:0;color:var(--ink);font-weight:500}
.doc td:first-child,.doc th:first-child{white-space:nowrap}
.doc p[align=center]{margin:24px 0;text-align:center}
.doc p[align=center]+p[align=center]{margin-top:-12px;font-size:15px;color:var(--ink-3)}
.doc img{max-width:100%;height:auto;border-radius:10px;border:1px solid var(--rule);background:var(--media-bg);box-shadow:var(--media-shadow);vertical-align:middle}
.rise{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
@media (max-width:720px){
  .page{padding:56px 20px 48px}
  h1{font-size:40px}
  .doc td:first-child,.doc th:first-child{white-space:normal}
}
`;

export function renderDoc(page: DocPage, pages: DocPage[], assets: Assets): string {
  const up = page.slug === "" ? "./" : "../";

  const place = {
    home: `${up}../`,
    docs: up,
    changelog: `${up}../changelog/`,
    active: "docs" as const,
  };

  const nav = pages
    .flatMap((candidate) => {
      if (candidate.slug === "") return [];

      return [
        candidate.slug === page.slug
          ? `<span class="active" aria-current="page">${escape(candidate.title)}</span>`
          : `<a href="${up}${candidate.slug}/">${escape(candidate.title)}</a>`,
      ];
    })
    .join("");

  const body = `<div class="dots" aria-hidden="true"></div>
${bar(assets, place)}
<main class="page">
<div class="head rise">
<p class="eyebrow">${page.slug === "" ? "Docs" : `<a href="${up}">Docs</a>`}</p>
<h1>${escape(page.title)}</h1>
</div>
<nav class="pages rise" aria-label="Documentation">${nav}</nav>
<div class="doc rise">${renderBlocks(parseBlocks(page.markdown, page.file), page, pages)}</div>
</main>
${foot(`Made from <a href="${REPO}/blob/main/docs/${page.file}">docs/${page.file}</a>.`)}`;

  return document({
    title: page.slug === "" ? "Leglas Documentation" : `${page.title}, Leglas`,
    description: `${page.title}: the Leglas manual, made from the repository's docs/ folder.`,
    assets,
    styles: STYLES,
    body,
  });
}
