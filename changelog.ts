import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CHANGELOG.md, as a page.
 *
 * The changelog is the record: every release edits it, a cut dates it, and it
 * is what a GitHub or npm reader already sees. The page is made from it and
 * from nothing else, so there is one text to keep true and no second copy to
 * drift. `pnpm site` writes the page under dist/site; the Pages workflow does
 * the same on main and publishes what it wrote.
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

export const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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

const REPO = "https://github.com/FredAmartey/leglas";
const NPM = "https://www.npmjs.com/package/leglas";

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

export type Assets = {
  /** Satoshi, base64 woff2, the interface's own face. */
  fonts: { regular: string; medium: string };
  /** The mark and the wordmark as inline SVG, styled by the page. */
  mark: string;
  wordmark: string;
  /** The favicon as a data URL. */
  favicon: string;
};

/** Everything the page needs, read from where the repository already keeps it. */
export function loadAssets(root: string): Assets {
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const base64 = (path: string): string => readFileSync(join(root, path)).toString("base64");
  const favicon = read("packages/shell/public/favicon.svg");
  const stripStyle = (svg: string): string => svg.replace(/<style>[\s\S]*?<\/style>/, "");
  const mark = stripStyle(favicon).replace(
    /^<svg[^>]*viewBox="([^"]+)"[^>]*>/,
    '<svg class="mark" aria-hidden="true" viewBox="$1" width="26" height="26">',
  );
  const wordmark = stripStyle(read(".github/assets/wordmark.svg")).replace(
    /^<svg[^>]*viewBox="([^"]+)"[^>]*>/,
    '<svg class="wordmark" role="img" aria-label="Leglas" viewBox="$1" width="52" height="18" fill="currentColor">',
  );
  return {
    fonts: {
      regular: base64("packages/shell/src/fonts/Satoshi-Regular.woff2"),
      medium: base64("packages/shell/src/fonts/Satoshi-Medium.woff2"),
    },
    mark,
    wordmark,
    favicon: `data:image/svg+xml;base64,${Buffer.from(favicon).toString("base64")}`,
  };
}

function styles(fonts: Assets["fonts"]): string {
  return `
@font-face{font-family:"Satoshi";font-weight:400;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${fonts.regular}) format("woff2")}
@font-face{font-family:"Satoshi";font-weight:500;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${fonts.medium}) format("woff2")}
:root{
  color-scheme:light;
  --sans:"Satoshi",ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --ground:#F8F8FB;--ink:#0B1839;
  --ink-2:rgba(11,24,57,.70);--ink-3:rgba(11,24,57,.50);--ink-4:rgba(11,24,57,.32);
  --rule:rgba(11,24,57,.22);--rule-soft:rgba(11,24,57,.09);--dot:rgba(11,24,57,.17);
  --code-bg:rgba(11,24,57,.06);--link:#2B4BC0;
  --pill-a:#EAF0FB;--pill-b:#B9C9FF;--pill-c:#DDEEF6;--pill-border:#1D3A9E;--pill-text:#0B1839;--pill-shine:rgba(255,255,255,.7);
  --chip-bg:#FFFFFF;--chip-border:rgba(11,24,57,.20);
  --media-bg:#EEF0F5;--media-shadow:rgba(11,24,57,.14);--bar-bg:rgba(248,248,251,.84);
  --cli:#3159CF;--mcp:#2AA68C;--plugin:#7C38E8;
  --m-g6a:#081327;--m-g6b:#0F266A;--m-g3a:#0E2B85;--m-g3b:#3159CF;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --ground:#141519;--ink:#E8ECF7;
  --ink-2:rgba(232,236,247,.72);--ink-3:rgba(232,236,247,.52);--ink-4:rgba(232,236,247,.34);
  --rule:rgba(232,236,247,.20);--rule-soft:rgba(232,236,247,.09);--dot:rgba(232,236,247,.14);
  --code-bg:rgba(232,236,247,.09);--link:#9AABE2;
  --pill-a:#E6EBF8;--pill-b:#9AABE2;--pill-c:#D2E6F0;--pill-border:#5F7FD8;--pill-text:#0B1839;--pill-shine:rgba(255,255,255,.5);
  --chip-bg:#1E1F25;--chip-border:rgba(232,236,247,.20);
  --media-bg:#1E1F25;--media-shadow:rgba(0,0,0,.5);--bar-bg:rgba(20,21,25,.84);
  --cli:#7E97DD;--mcp:#3EC2A8;--plugin:#B58CF2;
  --m-g6a:#E8ECF7;--m-g6b:#92A7E0;--m-g3a:#7E97DD;--m-g3b:#5F7FD8;
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --ground:#141519;--ink:#E8ECF7;
  --ink-2:rgba(232,236,247,.72);--ink-3:rgba(232,236,247,.52);--ink-4:rgba(232,236,247,.34);
  --rule:rgba(232,236,247,.20);--rule-soft:rgba(232,236,247,.09);--dot:rgba(232,236,247,.14);
  --code-bg:rgba(232,236,247,.09);--link:#9AABE2;
  --pill-a:#E6EBF8;--pill-b:#9AABE2;--pill-c:#D2E6F0;--pill-border:#5F7FD8;--pill-text:#0B1839;--pill-shine:rgba(255,255,255,.5);
  --chip-bg:#1E1F25;--chip-border:rgba(232,236,247,.20);
  --media-bg:#1E1F25;--media-shadow:rgba(0,0,0,.5);--bar-bg:rgba(20,21,25,.84);
  --cli:#7E97DD;--mcp:#3EC2A8;--plugin:#B58CF2;
  --m-g6a:#E8ECF7;--m-g6b:#92A7E0;--m-g3a:#7E97DD;--m-g3b:#5F7FD8;
}
*{box-sizing:border-box}
html{scroll-padding-top:96px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;position:relative;min-height:100vh}
a{color:var(--link)}
code{font-family:var(--mono);font-size:.88em;background:var(--code-bg);padding:.06em .28em;border-radius:5px;color:inherit}
.dots{position:absolute;top:0;left:0;right:0;height:440px;pointer-events:none;z-index:0;background-image:radial-gradient(var(--dot) 1px,transparent 1.3px);background-size:34px 34px;-webkit-mask-image:linear-gradient(#000 0 50%,transparent);mask-image:linear-gradient(#000 0 50%,transparent)}
.bar{position:sticky;top:0;z-index:5;background:var(--bar-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--rule-soft)}
.bar-row{max-width:1180px;margin:0 auto;padding:0 28px;height:60px;display:flex;align-items:center;gap:32px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none}
.mark path{stroke-width:38;stroke-linejoin:round}
.mark .ink{fill:var(--ink);stroke:var(--ink)}
.mark path[fill="url(#Gradient6)"]{stroke:url(#Gradient6)}
.mark path[fill="url(#Gradient5)"]{stroke:url(#Gradient5)}
.mark path[fill="url(#Gradient4)"]{stroke:url(#Gradient4)}
.mark path[fill="url(#Gradient3)"]{stroke:url(#Gradient3)}
.mark .g6a{stop-color:var(--m-g6a)}.mark .g6b{stop-color:var(--m-g6b)}.mark .g3a{stop-color:var(--m-g3a)}.mark .g3b{stop-color:var(--m-g3b)}
.nav{display:flex;align-items:center;gap:22px;font-size:15px;color:var(--ink-3);letter-spacing:-.01em}
.nav a{color:inherit;text-decoration:none}
.nav a:hover{color:var(--ink)}
.nav .active{color:var(--ink);font-weight:500}
.install{margin-left:auto;display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--ink-2);font:500 13px/1 var(--mono);letter-spacing:-.01em;cursor:pointer}
.install:hover{color:var(--ink)}
.install .done{display:none}
.install[data-done] .cmd{display:none}
.install[data-done] .done{display:inline}
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
.media{margin:6px 0 2px;display:flex;flex-direction:column;gap:8px}
.media img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--rule-soft);background:var(--media-bg);box-shadow:0 12px 28px var(--media-shadow)}
.media figcaption{font-size:13px;color:var(--ink-3)}
.foot{position:relative;z-index:1;border-top:1px solid var(--rule-soft)}
.foot-row{max-width:980px;margin:0 auto;padding:28px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;font-size:13px;color:var(--ink-3)}
.foot-row nav{display:flex;gap:18px;margin-left:auto}
.foot-row a{color:var(--ink-2);text-decoration:none}
.foot-row a:hover{color:var(--ink)}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.head{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.list{animation:rise .5s cubic-bezier(.2,.7,.2,1) .08s both}
@media (prefers-reduced-motion:reduce){.head,.list{animation:none}}
@media (max-width:720px){
  .bar-row{padding:0 20px;gap:18px}
  .nav{gap:16px;font-size:14px}
  .install{display:none}
  .page{padding:56px 20px 48px}
  h1{font-size:40px}
  .head{margin-bottom:40px}
  .entry{grid-template-columns:1fr;gap:14px;padding:32px 0}
  .aside{position:static;flex-direction:row;align-items:center;gap:12px;padding-top:0}
}
`;
}

export function renderPage(changelog: Changelog, assets: Assets): string {
  const standfirst = renderBlocks(
    changelog.preamble.filter((block): block is Item | Paragraph | Media => block.kind !== "group"),
    "",
  );
  const entries = changelog.entries.map(renderEntry).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leglas Changelog</title>
<meta name="description" content="What changed in each release of Leglas: the command line tool, the MCP server and the Agent Plugin.">
<link rel="icon" href="${assets.favicon}" type="image/svg+xml">
<style>${styles(assets.fonts)}</style>
</head>
<body>
<div class="dots" aria-hidden="true"></div>
<header class="bar"><div class="bar-row">
<a class="brand" href="${REPO}">${assets.mark}${assets.wordmark}</a>
<nav class="nav" aria-label="Site"><a href="${REPO}#readme">README</a><a href="${NPM}">npm</a><span class="active" aria-current="page">Changelog</span></nav>
<button class="install" type="button" title="Copy"><span class="cmd">npx leglas</span><span class="done">Copied</span></button>
</div></header>
<main class="page">
<div class="head">
<p class="eyebrow">Changelog</p>
<h1>What's new</h1>
<div class="standfirst">${standfirst}</div>
</div>
<div class="list">${entries}</div>
</main>
<footer class="foot"><div class="foot-row">
<span>Made from <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a>. Leglas is MIT licensed.</span>
<nav aria-label="Elsewhere"><a href="${REPO}">GitHub</a><a href="${NPM}">npm</a></nav>
</div></footer>
<script>
(function(){var b=document.querySelector(".install");if(!b||!navigator.clipboard)return;b.addEventListener("click",function(){navigator.clipboard.writeText("npx leglas").then(function(){b.dataset.done="1";setTimeout(function(){delete b.dataset.done},1200)},function(){})})})();
</script>
</body>
</html>
`;
}

/**
 * The site is the changelog at /changelog/ and a root that sends you there,
 * until there is a homepage to send you to instead. Written under dist/site,
 * which is ignored, so nothing generated is ever committed.
 */
export function buildSite(root: string, out: string): string[] {
  const changelog = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  const page = renderPage(changelog, loadAssets(root));
  const redirect = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=changelog/"><title>Leglas</title></head>
<body><p><a href="changelog/">What's new in Leglas</a></p></body></html>
`;
  mkdirSync(join(out, "changelog"), { recursive: true });
  const written = [join(out, "changelog", "index.html"), join(out, "index.html")];
  writeFileSync(written[0]!, page);
  writeFileSync(written[1]!, redirect);
  return written;
}

if (import.meta.main) {
  const root = import.meta.dirname;
  for (const path of buildSite(root, join(root, "dist", "site"))) {
    process.stdout.write(`${path}\n`);
  }
}
