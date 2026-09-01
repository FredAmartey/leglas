import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the site's pages share: the assets read out of the tree, the design
 * tokens in both themes, the bar, the footer, and the document around them.
 * A page owns its own content and the styles for it, and nothing else.
 */

export const REPO = "https://github.com/FredAmartey/leglas";
export const NPM = "https://www.npmjs.com/package/leglas";

export const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export type Assets = {
  /** Satoshi, base64 woff2, the interface's own face. */
  fonts: { regular: string; medium: string };
  /** The mark and the wordmark as inline SVG, styled by the page. */
  mark: string;
  wordmark: string;
  /** The favicon as a data URL. */
  favicon: string;
};

/** Everything a page needs, read from where the repository already keeps it. */
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

/**
 * The palette in three states: the bare root is light, the dark media query
 * applies unless the reader chose light, and an explicit dark choice wins.
 * Every colour a page uses comes from these, so a page never has to know
 * which theme it is in.
 */
const DARK = `
  color-scheme:dark;
  --ground:#141519;--ink:#E8ECF7;
  --ink-2:rgba(232,236,247,.72);--ink-3:rgba(232,236,247,.52);--ink-4:rgba(232,236,247,.34);
  --rule:rgba(232,236,247,.20);--rule-soft:rgba(232,236,247,.09);--dot:rgba(232,236,247,.14);
  --code-bg:rgba(232,236,247,.09);--link:#9AABE2;
  --pill-a:#E6EBF8;--pill-b:#9AABE2;--pill-c:#D2E6F0;--pill-border:#5F7FD8;--pill-text:#0B1839;--pill-shine:rgba(255,255,255,.5);
  --chip-bg:#1E1F25;--chip-border:rgba(232,236,247,.20);
  --media-bg:#1E1F25;--media-shadow:rgba(0,0,0,.5);--bar-bg:rgba(20,21,25,.84);
  --cli:#7E97DD;--mcp:#3EC2A8;--plugin:#B58CF2;
  --star:#FACC15;--spark:#FEF08A;
  --m-g6a:#E8ECF7;--m-g6b:#92A7E0;--m-g3a:#7E97DD;--m-g3b:#5F7FD8;
  --icon-sun:inline;--icon-moon:none;
`;

export function baseStyles(fonts: Assets["fonts"]): string {
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
  --star:#D99A00;--spark:#EFC13A;
  --m-g6a:#081327;--m-g6b:#0F266A;--m-g3a:#0E2B85;--m-g3b:#3159CF;
  --icon-sun:none;--icon-moon:inline;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
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
.bar-end{margin-left:auto;display:flex;align-items:center;gap:10px}
.install{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--ink-2);font:500 13px/1 var(--mono);letter-spacing:-.01em;cursor:pointer}
.install:hover{color:var(--ink)}
.install .done{display:none}
.install[data-done] .cmd{display:none}
.install[data-done] .done{display:inline}
.theme{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:999px;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--ink-2);cursor:pointer}
.theme:hover{color:var(--ink)}
.theme .sun{display:var(--icon-sun)}
.theme .moon{display:var(--icon-moon)}
.media{margin:6px 0 2px;display:flex;flex-direction:column;gap:8px}
.media img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--rule-soft);background:var(--media-bg);box-shadow:0 12px 28px var(--media-shadow)}
.media figcaption{font-size:13px;color:var(--ink-3)}
.foot{position:relative;z-index:1;border-top:1px solid var(--rule-soft)}
.foot-row{max-width:980px;margin:0 auto;padding:28px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;font-size:13px;color:var(--ink-3)}
.foot-row nav{display:flex;gap:18px;margin-left:auto}
.foot-row a{color:var(--ink-2);text-decoration:none}
.foot-row a:hover{color:var(--ink)}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
/* The theme arrives as a circle opening from the switch. Both snapshots lose
   their default cross-fade, the new one is drawn over the old, and only its
   clip grows, so what spreads is the new theme rather than a dissolve between
   two. The origin and the radius are measured at the click: the radius
   reaches the furthest corner of the viewport, which is what makes the sweep
   finish exactly as it covers the last of the page. */
::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}
::view-transition-old(root){z-index:0}
::view-transition-new(root){z-index:1}
@keyframes theme-reveal{from{clip-path:circle(0px at var(--vt-x,100%) var(--vt-y,0px))}to{clip-path:circle(var(--vt-r,150vmax) at var(--vt-x,100%) var(--vt-y,0px))}}
@media (prefers-reduced-motion:no-preference){
  ::view-transition-new(root){animation:theme-reveal 600ms cubic-bezier(.4,0,.2,1)}
}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.rise{animation:none !important}}
@media (max-width:720px){
  .bar-row{padding:0 20px;gap:18px}
  .nav{gap:16px;font-size:14px}
  .install{display:none}
}
`;
}

/** Where a page lives relative to the other, so links hold at any base. */
export type Place = { home: string; changelog: string; active: "home" | "changelog" };

export function bar(assets: Assets, place: Place): string {
  const link = (href: string, label: string, active: boolean): string =>
    active ? `<span class="active" aria-current="page">${label}</span>` : `<a href="${href}">${label}</a>`;
  return `<header class="bar"><div class="bar-row">
<a class="brand" href="${place.home}">${assets.mark}${assets.wordmark}</a>
<nav class="nav" aria-label="Site">${link(place.changelog, "Changelog", place.active === "changelog")}<a href="${REPO}#readme">README</a><a href="${NPM}">npm</a></nav>
<div class="bar-end">
<button class="install" type="button" data-copy="npx leglas" aria-label="Copy npx leglas" title="Copy"><span class="cmd">npx leglas</span><span class="done">Copied</span></button>
<button class="theme" type="button" data-theme-switch aria-label="Switch between light and dark">
<svg class="sun" aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>
<svg class="moon" aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z"/></svg>
</button>
</div>
</div></header>`;
}

export function foot(lead: string): string {
  return `<footer class="foot"><div class="foot-row">
<span>${lead} Leglas is MIT licensed.</span>
<nav aria-label="Elsewhere"><a href="${REPO}">GitHub</a><a href="${NPM}">npm</a></nav>
</div></footer>`;
}

/**
 * The reader's choice, applied before anything paints so the page never
 * flashes the other theme. No choice stored means the system decides, which
 * is the un-stamped state the tokens are written for.
 */
const STAMP_SCRIPT = `(function(){try{var t=localStorage.getItem("leglas-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})();`;

/**
 * The switch flips between light and dark from whatever is showing now,
 * which \`color-scheme\` reports without repeating the tokens' three-state
 * logic, and remembers the result.
 *
 * The new theme arrives as a circle opening from the switch itself, so the
 * change starts where the reader clicked and sweeps across the page at
 * whatever angle that corner implies. The origin is the button's own centre
 * and the radius is the distance to the furthest corner of the viewport,
 * both measured at the click, since a bar that moves or a window that
 * resizes would make a stored pair wrong. A browser without view
 * transitions, and a reader who asked for less motion, get the flip alone.
 * A hidden document skips the transition and rejects, which is why the
 * promise is caught: the flip itself still lands, and an unread rejection
 * would reach the console and anything listening for one.
 *
 * It also names the direction it would take you, which the markup cannot do:
 * a system-dark reader with no choice stored is offered light, and the file
 * is one document served to everybody. So the button ships undirected and
 * this is what makes it specific.
 */
const THEME_SCRIPT = `(function(){var b=document.querySelector("[data-theme-switch]");if(!b)return;var r=document.documentElement;function current(){return getComputedStyle(r).colorScheme==="dark"?"dark":"light"}function label(){b.setAttribute("aria-label",current()==="dark"?"Switch to light mode":"Switch to dark mode")}function flip(next){r.dataset.theme=next;try{localStorage.setItem("leglas-theme",next)}catch(e){}label()}b.addEventListener("click",function(){var next=current()==="dark"?"light":"dark";var box=b.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;r.style.setProperty("--vt-x",x+"px");r.style.setProperty("--vt-y",y+"px");r.style.setProperty("--vt-r",Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))+"px");if(!document.startViewTransition||matchMedia("(prefers-reduced-motion: reduce)").matches){flip(next);return}document.startViewTransition(function(){flip(next)}).ready.catch(function(){})});label();matchMedia("(prefers-color-scheme: dark)").addEventListener("change",label)})();`;

/**
 * Share copies the page's address and says so on the button, the way the
 * copy controls do, which on a desk is the thing a reader actually wants:
 * the next stop is a chat window or an issue, and the system's share sheet
 * offers neither. On a phone the sheet is where everything lives, so a
 * device without hover gets it instead. The address is the page's path
 * alone, with no query and no fragment, since where the reader happens to
 * be on the page is not what they are sharing. A sheet the reader
 * dismisses rejects, and that is not an error.
 */
const SHARE_SCRIPT = `(function(){var b=document.querySelector("[data-share]");if(!b)return;var data={title:document.title,text:b.dataset.share,url:location.origin+location.pathname};b.addEventListener("click",function(){if(navigator.share&&matchMedia("(hover: none)").matches&&(!navigator.canShare||navigator.canShare(data))){navigator.share(data).catch(function(){});return}if(!navigator.clipboard)return;navigator.clipboard.writeText(data.url).then(function(){b.dataset.done="1";setTimeout(function(){delete b.dataset.done},1200)},function(){})})})();`;

/** Every copy control on a page copies the command in it. */
const COPY_SCRIPT = `(function(){if(!navigator.clipboard)return;document.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){navigator.clipboard.writeText(b.dataset.copy).then(function(){b.dataset.done="1";setTimeout(function(){delete b.dataset.done},1200)},function(){})})})})();`;

export function document(options: {
  title: string;
  description: string;
  assets: Assets;
  styles: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<meta name="description" content="${escape(options.description)}">
<link rel="icon" href="${options.assets.favicon}" type="image/svg+xml">
<script>${STAMP_SCRIPT}</script>
<noscript><style>.theme,.share{display:none}</style></noscript>
<style>${baseStyles(options.assets.fonts)}${options.styles}</style>
</head>
<body>
${options.body}
<script>
${COPY_SCRIPT}
${SHARE_SCRIPT}
${THEME_SCRIPT}
</script>
</body>
</html>
`;
}
