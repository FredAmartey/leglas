import { REPO, bar, document, escape, foot, type Assets } from "./chrome.ts";

/**
 * CHANGELOG.md, as a page.
 *
 * The changelog is the record: every release edits it, a cut dates it, and it
 * is what a GitHub or npm reader already sees. The page is made from it and
 * from nothing else, so there is one text to keep true and no second copy to
 * drift. `pnpm site` (site.ts) writes the page under dist/site; the Pages
 * workflow does the same on main and publishes what it wrote.
 *
 * The reader understands the markdown this file actually uses rather than
 * markdown in general: a release heading, a group heading, a bullet with a
 * bold lead and an audience tag, a paragraph, an image line. A construct the
 * page cannot show fails here, in the pull request that added it, rather than
 * quietly dropping off the site.
 */

/**
 * The three things a release reaches, spelled the way the tag at the end of a
 * bullet spells them. An unknown spelling is refused rather than shown as a
 * fourth thing.
 */
export const TARGETS = {
  "`leglas`": { key: "cli", label: "leglas" },
  "`leglas-mcp`": { key: "mcp", label: "leglas-mcp" },
  plugin: { key: "plugin", label: "plugin" },
} as const;

export type Target = (typeof TARGETS)[keyof typeof TARGETS]["key"];

/** One bullet: an optional bold lead, its text, further paragraphs, and who it reaches. */
export type Item = { kind: "item"; lead: string | null; text: string; more: string[]; reaches: Target[] };
export type Paragraph = { kind: "paragraph"; text: string };
export type Media = { kind: "media"; src: string; alt: string; caption: string | null };
export type Group = { kind: "group"; heading: string; blocks: (Item | Paragraph | Media)[] };
export type Block = Item | Paragraph | Media | Group;

/**
 * One release. `versions` is usually one number; the first entry covers two
 * releases and names both. `date` and `title` come off the heading, written
 * as `## 0.8.0 (2026-08-28): What the release is about`, and an Unreleased
 * section carries neither.
 */
export type Entry = { versions: string[]; date: string | null; title: string | null; blocks: Block[] };
export type Changelog = { preamble: Block[]; entries: Entry[] };

const RELEASE = /^## (.+?)(?: \((\d{4}-\d{2}-\d{2})\))?(?:: (.+))?$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?: "([^"]*)")?\)$/;
const TAG = /\s*\(((?:`[^`]+`|plugin)(?:, (?:`[^`]+`|plugin))*)\)$/;
/**
 * A real tag anywhere else: one that punctuation or a sentence has pushed off
 * the end. Only the three names count, since a parenthetical of commands,
 * "(`claude auth status`, `codex login status`)", is ordinary prose.
 */
const AUDIENCE = Object.keys(TARGETS)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const STRAY_TAG = new RegExp(`\\((?:${AUDIENCE})(?:, (?:${AUDIENCE}))*\\)`);

const tidy = (lines: string[]): string => lines.join(" ").replace(/\s+/g, " ").trim();

export function parseChangelog(markdown: string): Changelog {
  const preamble: Block[] = [];
  const entries: Entry[] = [];
  let entry: Entry | null = null;
  let group: Group | null = null;
  let paragraph: string[] | null = null;
  let item: { paragraphs: string[][]; gap: boolean } | null = null;

  const container = (): Block[] => group?.blocks ?? entry?.blocks ?? preamble;

  const closeParagraph = (): void => {
    if (paragraph) container().push({ kind: "paragraph", text: tidy(paragraph) });
    paragraph = null;
  };

  const closeItem = (): void => {
    if (!item) return;
    const paragraphs = item.paragraphs.map(tidy).filter((text) => text.length > 0);
    item = null;
    const last = paragraphs.length - 1;
    const reaches: Target[] = [];
    const tagged = paragraphs[last]?.match(TAG);
    if (tagged?.[1] !== undefined) {
      for (const name of tagged[1].split(", ")) {
        const target = (TARGETS as Record<string, { key: Target } | undefined>)[name];
        if (!target) throw new Error(`Unknown audience ${name} in "${paragraphs[last]}".`);
        reaches.push(target.key);
      }
      paragraphs[last] = paragraphs[last]!.slice(0, -tagged[0].length).trim();
    }
    // A tag followed by a full stop, or one in the middle of a sentence,
    // would otherwise stay in the prose and the chip would quietly not
    // appear. The bullet ends with the tag, or it has no tag.
    const stray = paragraphs.find((text) => STRAY_TAG.test(text));
    if (stray !== undefined) {
      throw new Error(`An audience tag ends its bullet, with nothing after it: "${stray}".`);
    }
    const [first = "", ...more] = paragraphs;
    let lead: string | null = null;
    let text = first;
    if (first.startsWith("**")) {
      const end = first.indexOf("**", 2);
      if (end > 2) {
        lead = first.slice(2, end);
        text = first.slice(end + 2).trim();
      }
    }
    container().push({ kind: "item", lead, text, more, reaches });
  };

  for (const line of markdown.split("\n")) {
    if (item) {
      if (/^ {2,}\S/.test(line)) {
        // A nested list would be absorbed as prose, marker and all.
        if (/^ {2,}- /.test(line)) throw new Error(`A bullet inside a bullet is not supported: "${line.trim()}".`);
        if (item.gap) item.paragraphs.push([]);
        item.paragraphs[item.paragraphs.length - 1]!.push(line.trim());
        item.gap = false;
        continue;
      }
      if (line.trim() === "") {
        item.gap = true;
        continue;
      }
      closeItem();
    }

    if (line.trim() === "") {
      closeParagraph();
    } else if (line.startsWith("# ")) {
      closeParagraph();
    } else if (line.startsWith("## ")) {
      closeParagraph();
      const heading = RELEASE.exec(line);
      if (!heading) throw new Error(`Unreadable release heading: "${line}".`);
      entry = {
        versions: heading[1]!.split(/\s+and\s+/),
        date: heading[2] ?? null,
        title: heading[3] ?? null,
        blocks: [],
      };
      group = null;
      entries.push(entry);
    } else if (line.startsWith("### ")) {
      closeParagraph();
      if (!entry) throw new Error(`A group heading before any release: "${line}".`);
      group = { kind: "group", heading: line.slice(4).trim(), blocks: [] };
      entry.blocks.push(group);
    } else if (line.startsWith("- ")) {
      closeParagraph();
      item = { paragraphs: [[line.slice(2).trim()]], gap: false };
    } else if (IMAGE.test(line)) {
      closeParagraph();
      const [, alt = "", src = "", caption] = IMAGE.exec(line)!;
      container().push({ kind: "media", src, alt, caption: caption ?? null });
    } else {
      // A group holds bullets and pictures. Prose here is nearly always a
      // bullet's second paragraph that lost its indent, which would split
      // the list in two around a stray paragraph and nothing would say so.
      if (group !== null) {
        throw new Error(
          `A paragraph inside "${group.heading}": "${line.trim()}". ` +
            "Indent it by two spaces to keep it in its bullet, or put it above the group.",
        );
      }
      (paragraph ??= []).push(line.trim());
    }
  }
  closeItem();
  closeParagraph();

  return { preamble, entries };
}

/** Code spans, bold and links: the inline markdown the changelog uses. */
export function inline(markdown: string): string {
  const pattern = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let html = "";
  let last = 0;
  for (const match of markdown.matchAll(pattern)) {
    html += escape(markdown.slice(last, match.index));
    const [whole, code, bold, label, href] = match;
    if (code !== undefined) html += `<code>${escape(code)}</code>`;
    else if (bold !== undefined) html += `<strong>${inline(bold)}</strong>`;
    else if (label !== undefined && href !== undefined) html += `<a href="${escape(href)}">${inline(label)}</a>`;
    last = match.index + whole.length;
  }
  return html + escape(markdown.slice(last));
}

/** 2026-08-28 as "Aug 28, 2026", the way a reader says it. */
export function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const anchor = (entry: Entry): string =>
  /^\d/.test(entry.versions[0]!) ? `v${entry.versions[0]!}` : entry.versions[0]!.toLowerCase();

function renderItem(item: Item): string {
  // A lead running straight into punctuation ("**`leglas`**, the command
  // line tool") keeps no space; one followed by a sentence gets one.
  const joiner = item.text === "" || /^[,.;:!?)]/.test(item.text) ? "" : " ";
  const lead = item.lead === null ? "" : `<strong class="lead">${inline(item.lead)}</strong>${joiner}`;
  const more = item.more.map((text) => `<p class="more">${inline(text)}</p>`).join("");
  const reaches =
    item.reaches.length === 0
      ? ""
      : `<span class="reaches"><span class="reaches-label">reaches</span>${item.reaches
          .map((key) => {
            const label = Object.values(TARGETS).find((target) => target.key === key)!.label;
            return `<span class="chip chip-${key}">${label}</span>`;
          })
          .join("")}</span>`;
  return `<li><span class="text">${lead}${inline(item.text)}</span>${more}${reaches}</li>`;
}

/** Runs of bullets become one list; everything else stands on its own. */
function renderBlocks(blocks: (Item | Paragraph | Media)[], paragraphClass: string): string {
  const out: string[] = [];
  let items: Item[] = [];
  const flush = (): void => {
    if (items.length > 0) out.push(`<ul class="items">${items.map(renderItem).join("")}</ul>`);
    items = [];
  };
  for (const block of blocks) {
    if (block.kind === "item") {
      items.push(block);
      continue;
    }
    flush();
    if (block.kind === "paragraph") {
      out.push(`<p class="${paragraphClass}">${inline(block.text)}</p>`);
    } else {
      // A capture is shot at 2x and cropped to its subject, so its natural
      // size is twice what it should take up and its subject is often
      // narrower than the column. `#w=<css px>` on the URL says how wide to
      // draw it; a fragment is ignored by every image host and by GitHub, so
      // CHANGELOG.md reads the same everywhere.
      const [src, hint] = block.src.split("#w=");
      const width = hint !== undefined && /^\d+$/.test(hint) ? ` style="max-width:${hint}px"` : "";
      const caption = block.caption === null ? "" : `<figcaption>${inline(block.caption)}</figcaption>`;
      out.push(
        `<figure class="media"${width}><img src="${escape(src ?? "")}" alt="${escape(block.alt)}" loading="lazy" decoding="async">${caption}</figure>`,
      );
    }
  }
  flush();
  return out.join("");
}

function renderEntry(entry: Entry): string {
  const id = anchor(entry);
  const pills = entry.versions
    .map((version) => `<a class="pill" href="#${id}">${/^\d/.test(version) ? `v${version}` : escape(version)}</a>`)
    .join("");
  const date =
    entry.date === null
      ? `<span class="date">Not yet released</span>`
      : `<time class="date" datetime="${entry.date}">${longDate(entry.date)}</time>`;
  const title =
    entry.title === null ? "" : `<h2 class="title"><a href="#${id}">${inline(entry.title)}</a></h2>`;
  const body = entry.blocks
    .map((block) =>
      block.kind === "group"
        ? `<section class="group"><h3 class="group-head">${inline(block.heading)}</h3>${renderBlocks(block.blocks, "intro")}</section>`
        : renderBlocks([block], "intro"),
    )
    .join("");
  return `<article class="entry" id="${id}"><div class="aside">${pills}${date}</div><div class="body">${title}${body}</div></article>`;
}

const STYLES = `
.page{position:relative;z-index:1;max-width:980px;margin:0 auto;padding:96px 28px 80px}
.head{display:flex;flex-direction:column;gap:10px;margin-bottom:56px}
.eyebrow{margin:0;font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
h1{margin:0;font-size:56px;font-weight:500;letter-spacing:-.03em;line-height:1.05;text-wrap:balance}
.standfirst{max-width:640px;margin-top:10px;display:flex;flex-direction:column;gap:10px;color:var(--ink-2);font-size:17px;line-height:1.55;letter-spacing:-.01em}
.standfirst p{margin:0}
.standfirst ul{margin:0;padding-left:20px}
.standfirst li::marker{color:var(--ink-4)}
.standfirst .items li+li{margin-top:6px}
.list{display:flex;flex-direction:column}
.entry{display:grid;grid-template-columns:150px minmax(0,1fr);gap:48px;padding:44px 0;border-top:1px dotted var(--rule)}
.entry:first-child{border-top:0;padding-top:0}
.aside{position:sticky;top:88px;align-self:start;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding-top:4px}
.pill{display:inline-flex;align-items:center;height:24px;padding:0 10px 1px;border-radius:999px;font-size:13px;font-weight:500;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--pill-text);text-decoration:none;background:linear-gradient(var(--pill-a) 0%,var(--pill-b) 46%,var(--pill-c) 100%);border:1px solid var(--pill-border);box-shadow:0 1px 2px rgba(11,24,57,.14),inset 0 1px 0 var(--pill-shine)}
.date{font-size:14px;color:var(--ink-3);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.body{display:flex;flex-direction:column;gap:14px;min-width:0}
.title{margin:0;font-size:26px;font-weight:500;letter-spacing:-.025em;line-height:1.2;text-wrap:balance}
.title a{color:inherit;text-decoration:none}
.title a:hover{text-decoration:underline;text-decoration-color:var(--ink-4);text-underline-offset:.14em}
.intro{margin:0;font-size:17px;line-height:1.55;color:var(--ink-2);letter-spacing:-.01em}
.group{display:flex;flex-direction:column;gap:12px;margin-top:16px}
.group-head{margin:0;font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.group .intro{font-size:16px}
.items{margin:0;padding-left:20px;list-style:disc outside}
.items li{font-size:16px;line-height:1.55;color:var(--ink-2);letter-spacing:-.01em}
.items li+li{margin-top:14px}
.items li::marker{color:var(--ink-4)}
.lead{color:var(--ink);font-weight:500}
.more{margin:8px 0 0}
.reaches{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:7px}
.reaches-label{font-size:11px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 7px;border-radius:999px;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--ink-2);font:500 12px/1 var(--mono);letter-spacing:-.01em}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--chip-dot,var(--ink-4))}
.chip-cli{--chip-dot:var(--cli)}.chip-mcp{--chip-dot:var(--mcp)}.chip-plugin{--chip-dot:var(--plugin)}
.head{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.list{animation:rise .5s cubic-bezier(.2,.7,.2,1) .08s both}
@media (max-width:720px){
  .page{padding:56px 20px 48px}
  h1{font-size:40px}
  .head{margin-bottom:40px}
  .entry{grid-template-columns:1fr;gap:14px;padding:32px 0}
  .aside{position:static;flex-direction:row;align-items:center;gap:12px;padding-top:0}
}
`;

export function renderPage(changelog: Changelog, assets: Assets): string {
  const standfirst = renderBlocks(
    changelog.preamble.filter((block): block is Item | Paragraph | Media => block.kind !== "group"),
    "",
  );
  const entries = changelog.entries.map(renderEntry).join("");
  const body = `<div class="dots" aria-hidden="true"></div>
${bar(assets, { home: "../", changelog: "./", active: "changelog" })}
<main class="page">
<div class="head rise">
<p class="eyebrow">Changelog</p>
<h1>What's new</h1>
<div class="standfirst">${standfirst}</div>
</div>
<div class="list rise">${entries}</div>
</main>
${foot(`Made from <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a>.`)}`;
  return document({
    title: "Leglas Changelog",
    description: "What changed in each release of Leglas: the command line tool, the MCP server and the Agent Plugin.",
    assets,
    styles: STYLES,
    body,
  });
}
