<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/logo-duo.svg" width="640" alt="The Leglas mark, in light and dark" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/wordmark.svg" width="190" alt="Leglas" />
</p>

<p align="center">Your app is the canvas.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/leglas"><img src="https://img.shields.io/npm/v/leglas" alt="npm"></a>
  <a href="https://github.com/FredAmartey/leglas/actions/workflows/ci.yml"><img src="https://github.com/FredAmartey/leglas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/leglas" alt="license"></a>
  <a href="https://leglas.vercel.app/changelog/"><img src="https://img.shields.io/badge/changelog-what's%20new-0B1839" alt="changelog"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/rail-single.jpg" width="900" alt="The Leglas interface: a rail of design directions on the left, one of them with a variant grouped under it, and the selected one running as the real app filling the rest of the window" />
</p>

<p align="center"><i>Every direction in the rail, the selected one running as your actual app. Arrow keys flip between them.</i></p>

Code is becoming the source of truth. Features go from prompt to
working code in minutes, and mockups/design files eventually lag behind the product and drift out of sync. The
fastest teams already design in the medium they ship. Leglas is built
for working that way: it lets you explore many design directions at
once, live, in your own app.

The goal is to help devs and designers try many variations of a component, feature, page or user-flow quickly and make coming up with ideas extremely easy.

Ask your agent for a handful of directions for the landing page,
or the checkout component, or the empty states, or your onboarding flow. Leglas runs them all as your
actual app, side by side in one place, and holds your notes on each. Explore far and wide without losing focus: you see more ideas
without losing your opinion of any of them.

And because every variation is the real product, your judgment is real
too. Everything behaves the way it will in production, motion and data
included. Choosing between two directions is choosing between two
things that already exist, and the winner never has to be rebuilt from
a picture or design file.

Your app doesn't change to make any of this work. Leglas proxies the same
dev server in your project: one config file to delete when you're done
and sessions that clean up after themselves.

## What it does

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/compare-artboards.jpg" width="900" alt="The Leglas interface: the rail on the left, and two directions running side by side as the real app, each labelled with its name and the width it is drawn at." />
</p>

<p align="center"><i>Two directions for the same page, running side by side as the actual app.</i></p>

- Put any two directions side by side when it gets hard to choose.
- Name each direction, drag to reorder, set aside the ones that don't feel
  right. Your opinion of every idea survives a long exploration.
- Share the rail with someone who has no repo: a client, a cofounder, a
  teammate on another machine. They get the real app, in your order, and
  cannot change anything. See [Sharing](#sharing).
- Compare things no design tool can hold: three git branches, a local build
  against production, yesterday's direction against today's.
- Hand the workflow to your coding agent. `leglas init` teaches it, and
  `leglas explore` briefs an exploration: five separate ideas, or five
  variants of the one you already like. You choose the spread; your agent
  supplies the taste.
- Ask for changes without leaving the comparison. Describe what you want on
  the direction you are looking at, or point at it, and Leglas turns that
  into a precise request for your agent, file path and screenshots
  included. The agents on your machine are one click away next to the send
  button. Your agent, your subscription, no keys.
- A change makes a variant, not a rewrite. The result registers under the
  direction it came from, with the original still there to compare against.
- Keep the winner with one command. Leglas moves it into your source tree,
  writes down what the exploration decided and clears the rest away.
- No app yet? Plain HTML files compare the same way, no dev server needed.

## Get started

Start your dev server, then run Leglas from the project directory:

```sh
npx leglas
```

Leglas starts on port 4100, proxies your app and opens
`http://localhost:4100/leglas`. With no configuration you get a single
preview of your app root; add a config file to compare more than one thing.
If that port turns out to be served from outside your project, Leglas says
so and points at `devServer` and `--user-port` rather than quietly proxying
the wrong app.

It works with whatever you are building in. Leglas never imports or
executes your framework, so the target can be Next, Vite, Remix, SvelteKit,
Astro or a folder of static files. It needs Node 24 or newer, and nothing
else: `npx` fetches the CLI on first use and starts from the cache after
that. To pin a version for a project, `npm install -D leglas`; to type
`leglas` without the prefix, `npm install -g leglas`.

## Using Leglas

### The rail and the stage

Directions live in a rail on the left. The stage shows the active one in a
framed viewport at Full, 1440, 834 or 390 wide. Rename, reorder, hide and
tag directions from the rail; open the removed list to restore one, delete
it for good or clear the list. Your layout is saved per project and
survives restarts.

A small tools widget floats over the stage and can be dragged to any
corner. Its popover holds the viewport presets and a few preferences,
including hiding the dev badge your framework paints over the corner of
the app when it lands on the part you are judging.

### Comparing

Flipping shows a difference over time. A split shows it at once, which is
what you want for the last two in contention: press `C`, or hover a
direction and press its compare button, and it becomes the right pane
while the active direction holds the left.

Each side is drawn at the width it had on its own and scaled to fit, so
nothing reflows and flipping and splitting agree about what the design is.
An app given half the room would cross its own breakpoints and draw a
different design. If the narrow rendering is what you want, the tools
popover's "Scale each side to fit" switch is for that.

### Asking for a change

Type what you want into the field under the rail, or press `R`, and Leglas
composes a request naming the direction and the file behind it, copies it
to your clipboard and queues it. The direction it means is the one
highlighted directly above the field. By default the request asks for a
new variant beside that direction; the chip next to the send button
switches it to a change in place, for when a change really is a fix.

Pick an agent once from the picker beside the send button and the card
above the field shows it working: which file it is editing, how long it
has been, a stop if you change your mind, a retry when a run goes wrong.
Every request carries a screenshot of the direction at the width you are
looking at, a crop of anything you pointed at, the other pane when you are
comparing and any image you pasted in as a reference. Leglas runs no model
of its own; your agent already knows your conventions and your taste.

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-idle.png" width="290" alt="The change field, empty, with its agent picker reading Choose an agent" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-queued.png" width="290" alt="A card above the change field reading: Change queued, pick who runs your changes" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-pickedup.png" width="290" alt="A card above the change field reading: Codex is on it, editing .leglas/variants/hero/poster.tsx, 56s, with a stop button" />
</p>

<p align="center"><i>Nothing waiting, then a request queued, then an agent that has taken it.</i></p>

Hover any direction to see what it was built from and the change that was
asked for, in the words that were typed.

### Pointing at the problem

Most of what you would type is the part describing where the problem is,
so point at it instead. Press `A` and the preview becomes a picker:
hovering outlines the element under the pointer, clicking drops a numbered
pin that takes a note, and dragging marks an area and names every element
inside it. Click a pin again to reread it, reword it or drop it. The page
still scrolls, so the thing three screens down is as easy to mark as the
headline.

Annotations are a request on their own, so the field can stay empty: leave
three and send once. Each carries the element's own words, its tag and
classes, a path and the box it filled, and tells your agent which of those
to trust first, because the design moves under them by design. A pin whose
element has since gone turns amber rather than pointing confidently at the
wrong thing.

### Sharing

The rail is local, and the person who most needs to see it often has no
repo. The share control in the rail's header fixes that: pick the whole rail
as you see it, or what is on stage (one direction, or the pair being
compared), and start sharing. Leglas opens a second listener on your
machine, points a tunnel at it and copies the link once it answers.

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/share-links.png" width="426" alt="The share panel under the rail's header while sharing: the tunnel address, two links named Link 1 and Client review each with 24h left, the hovered row showing copy, extend and turn off, Another link, the scope line reading The whole rail, 6 directions, only what you shared, then Replace all and Stop" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/share-viewer.png" width="426" alt="The same rail as a viewer sees it: a strip reading Shared with you, the whole rail, then the directions in the sharer's order with no composer" />
</p>

<p align="center"><i>Sharing, and what the person on the other end gets.</i></p>

Whoever opens the link gets the real app, running, with your order, your
names, your folded families and your viewport. They can flip, compare,
search and change the width. They cannot change anything: the share
listener refuses every write, whoever the caller is, and answers every path
with 403 without the cookie the link sets, so your dev server never faces
the internet bare. Viewers do not get hot reload either, since an app's
live-reload socket is a way in; they refresh to see a change.

What a viewer can do is read what your dev server serves, and you choose
how much of it. **Anywhere in the app** is the whole dev server over GET,
source included, because Leglas proxies it faithfully and that is the
point; it suits a demo. **Only what you shared** serves the pages you shared
and the files they load, refuses the rest before the dev server hears of it
and holds against a console or curl as well as a browser. The list is read
off what your own directions loaded while you looked at them, not written
by hand, and anything it did not predict shows up in the panel with one
click to let that path or its folder through. Bounded still means a viewer
sees everything your shared pages themselves load. Either way Leglas
refuses the routes a dev server mounts to act on your machine, Vite's
editor launcher among them, hidden files like `.env` however the path is
spelled and a service worker that would outlive the share.

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/share-reach.png" width="426" alt="The share panel before starting: The whole rail, 6 directions, 2 on branches left out; The direction on stage, Table; How far they can go: Anywhere in the app, Your whole dev server over GET; Only what you shared, These pages and the 22 files they loaded; a Start sharing button" />
</p>

<p align="center"><i>Choosing what to share, and how far a viewer goes.</i></p>

A share hands out links rather than a link. Name one for each person, up
to sixteen; each lasts a day, extends by another with one click and turns
off on its own without touching the others. The panel shows which links
are answering and how many sessions are on each. When your rail has moved
since you shared, it offers to push what you see now; stop the share from
the same place, and it stops with Leglas either way.

The tunnel is borrowed, not shipped. Leglas looks for `cloudflared` or
`ngrok` on your machine and runs whichever it finds; with neither, the link
only works on this machine and the panel says so. Branch directions run on
their own port and are left out of a share for now.

### Keys

Arrows move between directions and `1` to `9` jump straight to one. `R`
asks for a change, `A` annotates, `C` compares, `Cmd K` (`Ctrl K`
elsewhere) searches, `T` opens the tools popover and `B` collapses the
rail. Press `?` for the whole keymap.

## Setting up a project

### Configuration

Create `leglas.config.ts` at the project root. `.js`, `.mjs` and `.json`
work too. Resolution walks upward from the working directory, so in a
monorepo the nearest file wins. Node reads the TypeScript config natively;
there is no compiler or extra dependency involved.

```ts
export default {
  devServer: "http://localhost:3000",
  previews: [
    { title: "Current", url: "/" },
    { title: "Wave", url: "/?v-hero=wave", note: "Full-bleed, anchored low.", tags: ["Hero"] },
    {
      title: "Dot grid",
      url: "/?v-hero=dotgrid",
      note: "Lattice that wakes near the pointer.",
      tags: ["Hero"],
    },
  ],
};
```

| Field            | Required      | Purpose                                                                 |
| ---------------- | ------------- | ----------------------------------------------------------------------- |
| `title`          | yes           | Label in the rail, and the key for your saved layout. Must be unique.   |
| `url`            | unless `file` | Root relative (`/pricing`) or absolute (`https://staging.example.com`)  |
| `note`           | no            | Second line under the title                                             |
| `tags`           | no            | The first tag renders as a pill                                         |
| `branch`         | no            | Preview a git branch instead of the running dev server                  |
| `file`           | no            | An HTML file served by Leglas itself, instead of `url`                  |
| `basedOn`        | no            | Title of the direction this is a variant of; the rail groups the family |
| `askedFor`       | no            | The change that was asked for, in the words that were typed             |
| `devServer`      | no            | Defaults to `http://localhost:3000`                                     |
| `devCommand`     | with `branch` | How to start the app. Must contain `{port}`.                            |
| `installCommand` | no            | Defaults to `npm install`                                               |
| `scanPreviews`   | no            | Set `false` to skip background duplicate scans for expensive apps      |

A broken config never stops the server. Leglas starts anyway and the
interface reports what to fix, so you are not hunting through a stack
trace.

The config is the shared description of a project: commit it and a
teammate gets the same directions on clone. `leglas add` registers a
preview on your machine only, in `.leglas/previews.json`, because
exploration is short-lived and its code lives in a gitignored directory;
`leglas list` shows both and marks which are local. Renaming a direction
in the rail is local in the same way, so the config title stays the one a
teammate sees, and `leglas show` and `leglas keep` take either name.

### Without a dev server

If the project exists but nothing is listening, set `devCommand` and
Leglas starts your app itself, proxies it and stops it on exit. When
`--user-port` names a server explicitly, Leglas never starts a different
one behind that flag.

If there is no app at all, a direction can be a plain HTML file:

```ts
export default {
  previews: [
    { title: "Aurora", file: ".leglas/pages/aurora.html" },
    { title: "Ember", file: ".leglas/pages/ember.html" },
  ],
};
```

Leglas serves each file from its own origin, so the full interface works
with no dev server anywhere. The file's directory is mounted rather than
the lone file, so stylesheets and images beside it resolve. When the real
app arrives, directions graduate to app code and nothing about the
interface changes.

### Comparing branches

A preview with a `branch` field is served from its own checkout: Leglas
creates a worktree, installs, starts the app with your `devCommand` on a
free port and tears it all down when you quit. In the interface it looks
like any other direction, so a branch against your working tree, or three
branches against each other, compares the same way two query parameters
do.

### How it works

Leglas runs one local server that serves the interface at `/leglas` and
forwards every other request to your dev server. Previews load through
that proxy, so they are same origin with the interface: no CORS
configuration, no cookie special cases.

The proxy is designed to be invisible. Hot module replacement survives
the hop, redirects that point at your dev server are rewritten to keep
you inside the interface, and responses stream rather than buffer. If an
app behaves differently through Leglas than on its own port, that is a
bug.

Because a preview is a URL, the same interface compares two routes, two
implementations behind a query parameter or a local server against a
deployed one. Absolute URLs load directly rather than through the proxy,
so a site that refuses to be framed will not preview; the interface says
so instead of showing an empty pane.

Leglas also compares what each preview actually draws and warns when two
are identical. This catches a typo like `?v-hero=wavee` that your app
silently ignores while the rail implies a comparison. The check reads the
rendered page, runs only on previews you have opened and skips
cross-origin previews, which the browser will not let it read.

### Limitations

- Leglas runs no model of its own. Comparing existing routes costs
  nothing, but a new direction is still code your agent writes; Leglas
  hands it the request and shows the result.
- The duplicate check compares rendered markup only, and only when the
  server renders some. Two previews that differ solely in a script are
  reported as identical, and in a fully client-rendered app the check
  says nothing.
- The interface is built for desktop widths.
- Leglas is a development tool. Nothing in it ships to production.

## Working with agents

The fastest way in is the agent skill:

```sh
npx skills add FredAmartey/leglas
```

One install, and your agent recognises "give me a few directions for the
pricing page" as a Leglas exploration in any project, including ones that
have never seen Leglas. It sets the project up itself and gets to work.

In a project, `npx leglas init` writes a section into `AGENTS.md`, creates
a starter config and gitignores Leglas's working directory. That section
is the agent's whole workflow, and it travels with the repo, so Claude
Code, Cursor, Codex or whatever you switch to next opens the project
already knowing how to add design directions to it. Every command accepts
`--json` and prints a single machine-readable envelope, so agents drive
the same CLI you do.

### Add beside, never rewrite

The instructions center on one rule. Two directions that rewrite the same
file cannot render from one server, and asking an agent to "make the hero
calmer" tempts it to edit the hero. So a direction is added next to what
exists: a switcher scaffolded beside your component, a query parameter
that selects it, and your real component untouched as the baseline.
Anything that cannot be additive, a dependency, a build change, an
existing file's behaviour, builds on its own git branch instead.

### What an agent runs

| Command | What it does |
| --- | --- |
| `leglas explore <surface> --count 6` | Briefs the exploration: what the set is for, and why it only works if the six genuinely disagree. `--based-on "Aurora"` flips it to six deliberate variants of one you like. The designs are the agent's; Leglas prescribes none. |
| `leglas new <surface> --from src/Hero.tsx` | Scaffolds a switcher under `.leglas/variants/`, with the baseline re-exporting your real component. Prints the one line to add and does not edit your file. Scaffolded branch points return the fallback in production builds. |
| `leglas classify --change … --rewrite …` | Says where a direction should live before it is written: in-app, where switching is instant, or on its own branch. |
| `leglas add --title … --url …` | Registers a direction on this machine. |
| `leglas show "Aurora" --json` | Everything about one direction: its entry, the file behind it, its variants, what it is compared against, what is pending. `--screenshot` renders it too, so an agent can look at what it built. |
| `leglas requests --json` | The change requests queued from the interface; `--clear` acknowledges them. |
| `leglas keep "Aurora" --to src/components/hero.tsx` | Moves the winner into real source and ends the exploration, writing what it decided into `design-log/` as markdown and PNGs. `leglas log` lists what is there. |

### Running requests

Requests made from the interface wait in a queue. An agent picked in the
interface drains it on its own. In a terminal, `npx leglas watch` is the
same loop with the agent's own output in view, and needs no flag once an
agent has been picked; for a CLI that is not in the picker, keep the
command explicit:

```sh
npx leglas watch --run "my-agent {prompt}"
```

### MCP server

For agent hosts that cannot run shell commands, `leglas-mcp` exposes the
same operations as MCP tools over stdio: `start`, `add`, `list`, `show`,
`classify`, `explore`, `scaffold`, `keep`, `requests` and `init`. Each
tool calls exactly what the CLI calls and returns the same envelope. The
`start` tool boots the viewer and returns its URL, and anything it started
stops when the session ends.

```sh
claude mcp add leglas -- npx -y leglas-mcp
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "leglas": { "command": "npx", "args": ["-y", "leglas-mcp"] } } }
```

The host's working directory names the project, the same contract as the
CLI. A host that starts the server somewhere else is asked where the
project is, over MCP roots. On a host that speaks channels, the server
pushes each request into the session as it arrives.

### Agent Plugin

The repository is also an [Agent Plugin](https://agent-plugins.org), the
open standard for shipping a skill and MCP configuration together, so a
client that implements it installs both in one step. It is a layout, not a
build: `plugin.json` and `mcp.json` at the root, the skill in
`skills/leglas/`. Such a client starts the server in the plugin's own
directory, so the project is taken from the workspace the host declares
over MCP roots, or from `LEGLAS_PROJECT_DIR` when it declares none. The
plugin's version covers the skill and the configuration; the server it
launches is whatever `npx` fetches, the same as every command above.

## Command line

```text
leglas init                Prepare a project and teach its agents
leglas [options]           Start the server and open the interface
leglas new <surface>       Scaffold a branch point for a surface
leglas explore <surface>   Brief an agent's exploration of a surface
leglas classify            Decide where a direction should live
leglas add --title T --url U   Register a preview on this machine
leglas list                Show every preview, shared and local
leglas log [entry]         What past explorations decided
leglas show <title>        Everything Leglas knows about one direction
leglas requests            Show change requests made from the interface
leglas watch --run "<cmd>" Hand each request to your agent as it arrives
leglas keep <title> --to <path>  Keep a winner and end the exploration
```

`--json` on any command prints a single machine-readable envelope.
`--port` chooses Leglas's own port and `--user-port` your dev server's;
`--config` names a config file instead of searching upward. Every
command's options are under `leglas <command> --help`.

## Development

This repository is a pnpm workspace: `pnpm install`, then `pnpm build`,
`pnpm test` and `pnpm typecheck`. Two packages are published, `leglas` and
`leglas-mcp`, and the repository is also the Agent Plugin. How to work on
it, what a pull request needs and how a release is cut are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
