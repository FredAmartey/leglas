import { REPO, bar, document, escape, foot, type Assets } from "./chrome.ts";

/**
 * The homepage. Everything on it is in the README at greater length; this is
 * the short form, in the same chrome as the changelog, for someone arriving
 * from a link rather than from npm.
 */

const DESCRIPTION = "Compare design directions inside your own running app.";

/** The README's own captures, copied beside the page by site.ts. */
export const CAPTURES = ["rail-single.jpg", "compare-artboards.jpg"] as const;

/**
 * A spring (stiffness 600, damping 25, unit mass) sampled as an easing, so
 * the icon swaps overshoot and settle the way a physical thing does rather
 * than easing to a stop. It reaches its target a third of the way through,
 * peaks at about 115% and is still by the end, which is what makes the
 * duration half a second while the motion reads as a quick flick. Browsers
 * without linear() drop the declaration and keep the bezier before it.
 */
const SPRING = "linear(0, .108, .349, .622, .859, 1.028, 1.123, 1.155, 1.143, 1.107, 1.065, 1.027, .999, .983, .976, .977, .982, .989, .995, 1, 1.002, 1.004, 1.004, 1.003, 1)";
const EASE = "cubic-bezier(.2,.7,.2,1)";

/** Lucide's outlines, drawn at 16px in the text's colour. */
const outline = (cls: string | null, paths: string): string =>
  `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const GITHUB = outline("from", '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>');
const STAR = outline(null, '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>');
const LINK = outline("from", '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
const SEND = outline("to", '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>');
/** The two sparks that come up with the star, one bigger and paler than the other. */
const SPARK = (cls: string): string =>
  `<svg class="spark ${cls}" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"/></svg>`;

const STYLES = `
.home{position:relative;z-index:1;max-width:980px;margin:0 auto;padding:104px 28px 80px}
.hero{max-width:760px;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:68px;font-weight:500;letter-spacing:-.035em;line-height:1.02;text-wrap:balance}
.standfirst{margin:0;max-width:640px;font-size:19px;line-height:1.5;color:var(--ink-2);letter-spacing:-.01em}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-top:8px}
.command{display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:999px;border:1px solid var(--pill-border);background:linear-gradient(var(--pill-a) 0%,var(--pill-b) 46%,var(--pill-c) 100%);color:var(--pill-text);font:500 15px/1 var(--mono);letter-spacing:-.01em;box-shadow:0 1px 2px rgba(11,24,57,.14),inset 0 1px 0 var(--pill-shine);cursor:pointer}
.command .done{display:none}
.command[data-done] .cmd{display:none}
.command[data-done] .done{display:inline}
.cta-note{font-size:14px;color:var(--ink-3)}
.asides{margin-left:auto;display:flex;align-items:center;gap:8px}
/* The two quiet actions. Hovering one swaps its icon for what the click
   means, GitHub for a star that brings two sparks up with it, a link for a
   paper plane, and the pill breathes out by 4px while it does. The swap is
   two layers in one 16px box, each moving on the spring above and fading
   faster than it moves, so the incoming icon is already visible while the
   outgoing one is still leaving. */
.action{position:relative;display:inline-flex;align-items:center;gap:10px;height:36px;padding:0 18px;border-radius:999px;border:0;background:color-mix(in srgb,var(--ink) 5%,transparent);color:var(--ink);font:500 14px/1 var(--sans);letter-spacing:-.015em;text-decoration:none;cursor:pointer;transition:padding .5s,background-color .15s,transform .5s;transition-timing-function:${EASE},ease,${EASE};transition-timing-function:${SPRING},ease,${SPRING}}
.action:is(:hover,:focus-visible){padding:0 22px;background:color-mix(in srgb,var(--ink) 8%,transparent);transform:scale(1.02)}
.action:active{transform:scale(.96)}
.action .icon{position:relative;width:16px;height:16px;flex:none}
.action .icon>*,.spark{position:absolute;transition:transform .5s,opacity .2s;transition-timing-function:${EASE},ease;transition-timing-function:${SPRING},ease}
.action .icon>*{inset:0}
.action .to{opacity:0}
.star .to{color:var(--star);transform:translateY(15px) scale(.8)}
.share .to{color:var(--link);transform:scale(.5)}
.action:is(:hover,:focus-visible,:active) .to{opacity:1;transform:none}
.star:is(:hover,:focus-visible,:active) .from{opacity:0;transform:translateY(-15px) scale(.8)}
.share:is(:hover,:focus-visible,:active) .from{opacity:0;transform:scale(.5)}
.spark{fill:currentColor;opacity:0}
.spark-a{top:-12px;right:-8px;width:10px;height:10px;color:var(--spark);transform:translateY(10px) rotate(-45deg) scale(0)}
.spark-b{top:-4px;left:-12px;width:6px;height:6px;color:var(--star);transform:translateX(10px) rotate(45deg) scale(0)}
.star:is(:hover,:focus-visible,:active) .spark{opacity:1;transform:none}
.star:is(:hover,:focus-visible,:active) .spark-a{transition-delay:.05s}
.star:is(:hover,:focus-visible,:active) .spark-b{transition-delay:.1s}
.share .done{display:none}
.share[data-done] .cmd{display:none}
.share[data-done] .done{display:inline}
@media (prefers-reduced-motion:reduce){.action,.action .icon>*,.spark{transition:none}}
.hero-media{margin-top:48px}
.section{display:grid;grid-template-columns:150px minmax(0,1fr);gap:48px;padding-top:48px;margin-top:56px;border-top:1px dotted var(--rule)}
.section h2{margin:0;padding-top:8px;font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.section-body{display:flex;flex-direction:column;gap:14px;min-width:0}
.section-title{margin:0;font-size:26px;font-weight:500;letter-spacing:-.025em;line-height:1.2;text-wrap:balance}
.prose p{margin:0;font-size:17px;line-height:1.55;color:var(--ink-2);letter-spacing:-.01em}
.prose p+p{margin-top:12px}
.points{margin:6px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:18px 36px}
.points li{font-size:16px;line-height:1.55;color:var(--ink-2);letter-spacing:-.01em}
.points strong{color:var(--ink);font-weight:500}
.points+.media{margin-top:28px}
.ways{margin:6px 0 0;display:flex;flex-direction:column;gap:18px}
.ways div{display:flex;flex-direction:column;gap:4px}
.ways dt{font:500 15px/1.4 var(--mono);letter-spacing:-.01em;color:var(--ink)}
.ways dt code{background:none;padding:0;font-size:1em}
.ways dd{margin:0;font-size:16px;line-height:1.55;color:var(--ink-2);letter-spacing:-.01em}
.rise{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.hero-media.rise{animation-delay:.08s}
@media (max-width:860px){
  .points{grid-template-columns:1fr}
}
@media (max-width:720px){
  .home{padding:56px 20px 48px}
  h1{font-size:44px}
  .hero{gap:16px}
  .asides{margin-left:0}
  .standfirst{font-size:17px}
  .hero-media{margin-top:32px}
  .section{grid-template-columns:1fr;gap:12px;padding-top:32px;margin-top:40px}
}
`;

export function renderHome(assets: Assets): string {
  const body = `<div class="dots" aria-hidden="true"></div>
${bar(assets, { home: "./", changelog: "./changelog/", active: "home" })}
<main class="home">
<section class="hero rise">
<h1>Your app is the canvas.</h1>
<p class="standfirst">Compare design directions inside your own running app. Ask your agent for a handful of directions for the landing page, the checkout, the empty states, and Leglas runs them all as your actual app, side by side in one place, holding your notes on each. Every variation is the real product, motion and data included, so choosing between two directions is choosing between two things that already exist.</p>
<div class="cta">
<button class="command" type="button" data-copy="npx leglas" aria-label="Copy npx leglas" title="Copy"><span class="cmd">npx leglas</span><span class="done">Copied</span></button>
<span class="cta-note">Nothing to install. Node 24 or newer.</span>
<div class="asides">
<a class="action star" href="${REPO}"><span class="icon">${GITHUB}<span class="to">${STAR}${SPARK("spark-a")}${SPARK("spark-b")}</span></span>Star on GitHub</a>
<button class="action share" type="button" data-share="${escape(DESCRIPTION)}"><span class="icon">${LINK}${SEND}</span><span class="cmd">Share</span><span class="done">Link copied</span></button>
</div>
</div>
</section>
<figure class="media hero-media rise">
<img src="assets/rail-single.jpg" width="2400" height="1350" alt="The Leglas interface: a rail of design directions on the left, one of them with a variant grouped under it, and the selected one running as the real app filling the rest of the window">
<figcaption>Every direction in the rail, the selected one running as your actual app. Arrow keys flip between them.</figcaption>
</figure>
<section class="section">
<h2>Why</h2>
<div class="section-body">
<p class="section-title">Design in the medium you ship.</p>
<div class="prose">
<p>Code is becoming the source of truth. Features go from prompt to working code in minutes, and mockups lag behind the product and drift out of sync. The fastest teams already design in the medium they ship, and Leglas is built for working that way: many directions at once, live, in your own app.</p>
<p>Your app does not change to make any of this work. Leglas proxies the dev server you are already running: one config file to delete when you are done, and sessions that clean up after themselves.</p>
</div>
</div>
</section>
<section class="section">
<h2>What you can do</h2>
<div class="section-body">
<p class="section-title">Explore far and wide without losing your opinion of anything.</p>
<ul class="points">
<li><strong>Compare side by side.</strong> Pick any two directions when it gets hard to choose.</li>
<li><strong>Keep your read on every idea.</strong> Name each direction, drag to reorder, set aside the ones that do not feel right. Your notes survive a long exploration.</li>
<li><strong>Send a link, not a screenshot.</strong> A teammate opens the live direction instead of a picture and a paragraph of explanation.</li>
<li><strong>Compare what no design tool can hold.</strong> Three git branches, a local build against production, yesterday's direction against today's.</li>
<li><strong>Your agent does the building.</strong> <code>leglas init</code> teaches any coding agent the workflow and <code>leglas explore</code> briefs an exploration. You choose the spread, your agent supplies the taste.</li>
<li><strong>Ask for changes where you are.</strong> Describe what you want on the direction you are looking at. Leglas turns it into a precise request, file path included, and hands it to the agent you picked, Claude Code, Codex or Cursor, without you leaving the comparison. Your agent, your subscription, no keys.</li>
<li><strong>The agent sees what you see.</strong> Every request carries a screenshot of the direction, a crop of whatever you pointed at, and any reference image you pasted in.</li>
<li><strong>Keep the winner with one command.</strong> It moves into your source tree, the exploration is cleared away, and what was decided is written down in <code>design-log/</code>.</li>
</ul>
<figure class="media">
<img src="assets/compare-artboards.jpg" width="2400" height="1350" loading="lazy" decoding="async" alt="The Leglas interface: the rail on the left, and two directions running side by side as the real app, each labelled with its name and the width it is drawn at">
<figcaption>Two directions for the same page, running side by side as the actual app.</figcaption>
</figure>
</div>
</section>
<section class="section">
<h2>How it works</h2>
<div class="section-body">
<p class="section-title">One proxy, and your app untouched.</p>
<div class="prose">
<p>Leglas runs one local server that serves the interface at <code>/leglas</code> and forwards every other request to your dev server. Previews load through that proxy, so they are same origin with the interface: no CORS configuration, no cookie special cases, and hot module replacement survives the hop.</p>
<p>It works with whatever you are building in. Leglas never imports or executes your framework, so the target can be Next, Vite, Remix, SvelteKit, Astro or a folder of static files.</p>
</div>
</div>
</section>
<section class="section">
<h2>Install</h2>
<div class="section-body">
<p class="section-title">There is nothing you have to install.</p>
<dl class="ways">
<div><dt><code>npx leglas</code></dt><dd>Fetches the CLI on first use and starts from npm's cache after that. Every instruction Leglas writes for agents uses the same form, so a fresh clone works with no setup.</dd></div>
<div><dt><code>npm install -D leglas</code></dt><dd>Pins the version in a project, so teammates and CI get the same Leglas from their normal install.</dd></div>
<div><dt><code>npx skills add FredAmartey/leglas</code></dt><dd>Teaches an agent the workflow in any project. The repository is also an Agent Plugin, so a client that implements the standard picks up the skill and the MCP server together.</dd></div>
</dl>
</div>
</section>
</main>
${foot(`The <a href="${REPO}#readme">README</a> says all of this at length.`)}`;
  return document({
    title: "Leglas",
    description: DESCRIPTION,
    assets,
    styles: STYLES,
    body,
  });
}
