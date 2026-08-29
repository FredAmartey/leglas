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
  <a href="https://fredamartey.github.io/leglas/changelog/"><img src="https://img.shields.io/badge/changelog-what's%20new-0B1839" alt="changelog"></a>
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

## What you can do with Leglas

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/compare-artboards.jpg" width="900" alt="The Leglas interface: the rail on the left, and two directions running side by side as the real app, each labelled with its name and the width it is drawn at." />
</p>

<p align="center"><i>Two directions for the same page, running side by side as the actual app.</i></p>

- Pick any two variations for side-by-side comparison when it gets hard to choose.
- Name each direction, drag to reorder and organise your variants, set aside the ones that
  don't feel right. Your actions on every idea survive a long exploration.
- Send a teammate the link to a direction. They open the live version instead of a screenshot and a paragraph of explanation.
- Compare things no design tool can hold: 3 git branches, a local
  build against production, yesterday's direction against today's, or even 7 different worktrees.
- `leglas init` teaches any coding agent the workflow, and
  `leglas explore` briefs an exploration. Five directions can be five
  separate ideas, or five variants of the one you already like: you choose
  the spread, your agent supplies the taste.
- Ask for changes without leaving the comparison: describe what you
  want on the direction you're looking at, and Leglas turns it into a
  precise request for your agent, file path included. The composer
  carries its own agent picker, the way every chat you already use
  carries a model picker: the CLIs found on your machine (Claude Code,
  Codex, Cursor) are one click away next to the send button. Leglas checks
  your shell path and the conventional per-user install locations, then asks
  each CLI for its login status so a signed-out agent says so before a run
  instead of failing one. Claude Code and Codex can optionally override effort
  for this project, remembered separately for each agent; `Agent default`
  leaves the CLI's own setting untouched. To
  work from an IDE panel or chat host, choose
  "Connect agent via MCP" for the exact setup and a live confirmation
  once the agent uses a Leglas tool. Each run
  reports in a card above the field: who is working, what file they
  are touching, how long it has been, a stop button while it runs and
  retry when it fails. Your agent, your subscription, no keys. Claude
  Code, Codex and Cursor pick the conversation back up between
  requests, so a run after the first goes straight to the change
  instead of reading the project again. Claude Code and Codex warm up
  while you type and let their process go once you have left Leglas
  alone for a few minutes, so an open window is not holding one.
  Prefer a terminal? `npx leglas watch` is the same loop with the
  agent's own output scrolling by. In Claude Code, the Leglas MCP
  server can also push each request straight into your open session as
  a channel event (channels are a research preview: start Claude Code
  with `--dangerously-load-development-channels
  server:<your leglas server name>`).
- A change makes a variant, not a rewrite. Ask for something on the
  direction you are looking at and the result registers under it in the
  rail, with the original still there to compare against. A chip beside
  the send button switches to changing the direction itself, for when a
  change really is a fix. Hover any direction to see what it was built
  from and the change that was asked for, in the words that were typed.
- Your agent sees what you see. Every change you send carries a screenshot
  of the direction at the width you are looking at, a crop of whatever you
  pointed at with a note, the other pane when you are comparing, and any
  image you pasted into the composer as a reference. Leglas renders them
  with a Chrome, Chromium, Brave or Edge already on your machine, nothing
  to install; with none found, the request says so and goes anyway. Agents
  can look for themselves too: `npx leglas show "Aurora" --screenshot`
  writes a PNG of a direction (`--width 390` for the phone layout) and the
  MCP `show` tool returns the image. The instructions Leglas writes for
  agents ask for one look after each change, so a broken layout gets fixed
  before you see it.
- Keep the winner with one command. Leglas moves it into your source
  tree and clears the exploration away.
- No app yet or want plain HTML comparisons? Some people want exactly that, and it works fine. Same comparison, no dev server.

## Quick start

Start your dev server, then run Leglas from the project directory:

```sh
npx leglas
```

Leglas starts on port 4100, proxies your app, and opens
`http://localhost:4100/leglas`. With no configuration you get a single
preview of your app root. Add a config file to compare more than one thing.
If that port turns out to be served from outside your project, Leglas
says so and points at `devServer` and `--user-port` rather than quietly
proxying the wrong app.

It works with whatever you're building in. Leglas never imports or
executes your framework, so the target can be Next, Vite, Remix,
SvelteKit, Astro, or a folder of static files.

## Install

There is nothing you have to install: `npx leglas` fetches the CLI on
first use and starts from npm's cache after that, and every instruction
Leglas writes for agents uses the same form, so a fresh clone works
with no setup at all. Requires Node 24 or newer.

Two optional upgrades:

- `npm install -D leglas` pins the version in a project. Teammates and
  CI get the same Leglas from their normal install, and `npx` resolves
  the local copy from then on.
- `npm install -g leglas` is for typing `leglas` without the prefix.

## Working with coding agents

The fastest way in is the agent skill:

```sh
npx skills add FredAmartey/leglas
```

One install, and your agent recognises "give me a few directions for the
pricing page" as a Leglas exploration in any project, including ones
that have never seen Leglas. It sets the project up itself and gets to
work.

In a project, run `npx leglas init` once. It writes a section into your
project's `AGENTS.md`, creates a starter config, and gitignores Leglas's
working directory. That section travels with the repo, so Claude Code,
Cursor, Codex, or whatever you switch to next opens the project already
knowing how to add design directions to it. Every command accepts
`--json` and prints a single machine-readable envelope, so agents drive
the same CLI you do.

The instructions center on one rule: add beside what exists, never
rewrite it. Two directions that rewrite the same file cannot render from
one server, and asking an agent to "make the hero calmer" tempts it to
edit the hero. The supporting commands:

- `npx leglas explore hero --count 6` briefs the exploration: what the set
  is for, why it only works if the six genuinely disagree, and how each
  direction registers. Unbriefed, six requests come back as six variants
  of one idea. With `--based-on "Aurora"` the goal flips: six deliberate
  variants of a direction you already like, and drifting into a new
  direction is the failure. The designs themselves are the agent's;
  Leglas prescribes none.
- `npx leglas new hero --from src/Hero.tsx` scaffolds a switcher under
  `.leglas/variants/hero/`. With `--from`, the baseline re-exports your
  real component, so you never compare against a stale copy. Leglas
  prints the one line to add in your component and does not edit it,
  because rewriting a file it does not understand is how a tool breaks a
  codebase. Scaffolded branch points return the fallback in production
  builds, so a committed one cannot expose an unreleased direction.
- `npx leglas classify --change package.json --rewrite src/theme.css` answers
  where a direction should live before it is written. Changing
  dependencies, build configuration, or an existing file's behaviour
  cannot be additive, so those directions build on their own git branch
  and register with `leglas add --branch`. Everything else stays in-app,
  where switching is instant.
- `npx leglas show "Aurora" --json` answers for one direction: its entry, the
  source file behind it, the variants based on it, what it is being compared
  against, and anything still pending on it. Add `--screenshot` and it
  renders the direction too, so an agent can look at what it built. Copying
  a direction from the rail hands over a block that ends in this command, so
  an agent given the block can go and get the rest.
- `npx leglas keep "Aurora" --to src/components/hero.tsx` moves the winner
  into real source and ends the exploration. It also writes down what the
  exploration was, into `design-log/`: every direction with its note, the words
  you typed at each of them, the captures the agent was sent, and which one
  won. Plain markdown and PNGs, committed, so a pull request can link it and
  somebody can read it in three months without this tool. Exploring is
  episodic, and the archive is what makes coming back to a surface cheaper than
  starting over. `npx leglas log` lists what is there. Set `logDir` if you want
  it somewhere else.

Asking for a change works from the interface too. Type what you want
changed into the field under the rail (or press `R`) and Leglas composes a
prompt naming the direction and the file behind it, copies it to your
clipboard, and queues it. The direction it means is the one highlighted
directly above the field. By default the request asks for a new variant
beside that direction; the chip next to the send button switches it to a
change in place. Your agent drains the queue with `npx leglas requests --json` and clears
it with `--clear`. Leglas runs no model of its own; your agent already
knows your conventions and your taste.

Most of what you would type into that field is the part describing where
the problem is, so you can point at it instead. Press `A` and the preview
becomes a picker: hovering outlines the element under the pointer,
clicking drops a numbered pin that takes a note, and dragging marks an
area and names every element inside it. Click a pin again to reread what
it says, reword it or drop it. The page still scrolls, so the thing three
screens down is as easy to mark as the headline. Annotations
are a request on their own, so the field can stay empty; leave three and
send once. Each one carries the element's own words, its tag and classes,
a path and the box it filled, and the request tells your agent which of
those to trust first, because the design moves under them by design. One
whose element has since gone turns amber rather than pointing confidently
at the wrong thing, and one already sent with a change takes a ring until
that change settles.

The card above the field is the whole status: what you have queued, who
has taken it and for how long, and what went wrong when a run fails.

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-idle.png" width="290" alt="The change field, empty, with its agent picker reading Choose an agent" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-queued.png" width="290" alt="A card above the change field reading: Change queued, pick who runs your changes" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-pickedup.png" width="290" alt="A card above the change field reading: Codex is on it, editing .leglas/variants/hero/poster.tsx, 56s, with a stop button" />
</p>

<p align="center"><i>Nothing waiting, then a request queued, then an agent that has taken it.</i></p>

Pick an agent once and the same card shows it working: which file it is
editing, a stop if you change your mind, a retry when a run goes
wrong. `npx leglas watch` in another terminal is the same loop with the
agent's own output in view, and it needs no flag once an agent has been
picked in the interface.

To use a CLI that is not in the picker, keep the custom command explicit
in the terminal:

```sh
npx leglas watch --run "my-agent {prompt}"
```

### MCP server

For agent hosts that cannot run shell commands, `leglas-mcp` exposes the
same operations as MCP tools over stdio: `start`, `add`, `list`, `show`,
`classify`, `explore`, `scaffold`, `keep`, `requests`, and `init`. Each
tool calls exactly what the CLI calls and returns the same envelope.
`watch` is the one command with no tool behind it: it is a loop that
holds a terminal open, and on a host that speaks channels the server
already pushes each request into the session as it arrives.

```sh
claude mcp add leglas -- npx -y leglas-mcp
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "leglas": { "command": "npx", "args": ["-y", "leglas-mcp"] } } }
```

The host's working directory names the project, the same contract as the
CLI. A host that starts the server somewhere else is asked where the
project is, over MCP roots. The `start` tool boots the viewer and returns
its URL, and anything it started stops when the session ends.

### As an Agent Plugin

The repository is also an [Agent Plugin](https://agent-plugins.org), the
open standard for shipping Agent Skills and MCP server configuration in
one format. Clients that implement it install the skill and the server
together, instead of the two steps above. It is a layout rather than a
build: `plugin.json` and `mcp.json` at the root, the skill in
`skills/leglas/`, nothing generated.

An Agent Plugins client starts a plugin's server in the plugin's own
install directory rather than the project, so on that path the working
directory names a copy of Leglas and nothing else. The server therefore
takes the project from the workspace the host declares over MCP roots,
and the working directory only when it sits inside one. If a host offers
neither, `LEGLAS_PROJECT_DIR` names the project outright; without it the
tools report that there is no project rather than writing into a plugin
cache. `mcp.json` passes `${PLUGIN_ROOT}` for exactly that check, and
nothing else.

The plugin's version covers the skill and the configuration, not the
server it launches: `npx` fetches the current `leglas-mcp` the same way
every `npx leglas` in these instructions fetches the current CLI, which
keeps both faces of Leglas on one version in a project they share.

## Configuration

Create `leglas.config.ts` at the project root. `.js`, `.mjs`, and `.json`
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

## The interface

Directions live in a rail on the left. The stage shows the active one in
a framed viewport at Full, 1440, 834 or 390 wide. Rename, reorder, hide
and tag directions from the rail. Open the removed list to restore a
direction, delete one permanently or clear the full list. Machine-local
directions are removed from `.leglas/previews.json`; shared project config
and preview source files stay untouched. Layout is saved per project and
survives restarts and port changes.

Flipping shows a difference over time. A split shows it at once, which is
what you want for the last two directions in contention: press `C`, or
hover a direction and press its compare button, and it becomes the right
pane while the active direction holds the left.

A split does not hand each side half the room. An app given half the room
crosses its own breakpoints and draws a different design, so you would be
choosing between two narrow renderings of directions meant for the wide
one. Instead each side is drawn at the width it had on its own and scaled
to fit, keeping the same proportions, so nothing reflows and flipping and
splitting agree about what the design is. Each pane says the width it is
drawn at and the scale it is shown at. If you want the narrow rendering,
that is what the tools popover's "Scale each side to fit" switch is for.

Arrows move between directions, `1` to `9` jump straight to one, `R` asks
for a change to the one you are on, `A` annotates the design itself,
`Cmd K` (`Ctrl K` elsewhere) searches, `T` opens the tools popover and `B`
collapses the rail. Press `?` for the whole keymap.

A small tools widget floats over the stage and can be dragged to any
corner, because a floating control has a habit of sitting exactly where
you need to look. Its popover holds the viewport presets and a few
preferences.

Frameworks paint a dev badge over the corner of the running app. It
belongs to your app, so Leglas leaves it alone; when it lands on the part
you are judging, the popover hides it, and does that by styling inside
the preview frame, never by altering what the proxy forwards.

## Command line

```text
Usage
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

Options
  --user-port <port>   Port your dev server is on (default: from config, or 3000)
  --port <port>        Port for Leglas itself (default: 4100, next free if taken)
  --config <path>      Config file to use instead of searching upward
  --no-open            Do not open the browser
  --json               Print a single machine-readable envelope
  -h, --help           Show this
  -v, --version        Show the version

Options for new
  --print              Print the scaffold instead of writing it
  --from <path>        Use an existing component as the baseline

Options for explore
  --count <n>          How many directions (default 3)
  --based-on <title>     Variants of an existing direction instead of new ones

Options for watch
  --run <command>      Your agent, with {prompt} where the request goes, for
                       example "claude -p {prompt}". Remembered after first use
  --port <port>        Port Leglas itself is on (default: 4100)

Options for classify
  --change <path>      A file the direction creates or wires up (repeatable)
  --rewrite <path>     An existing file whose behaviour it must change (repeatable)

Options for add
  --note <text>        Second line under the title
  --tag <text>         Repeatable
  --branch <name>      Back the preview with a checkout of this git branch
  --file <path>        Preview a plain HTML file served by Leglas itself
  --based-on <title>   The direction this is a variant of; groups the family
  --asked-for <text>   The change that was asked for, in the words that were typed

Options for show
  --screenshot         Render the direction and write a PNG
  --width <n>          Capture width from 320 to 3840 (needs --screenshot)
  --port <port>        Running Leglas port (needs --screenshot)
```

`leglas.config.ts` is the shared description of a project: commit it and a
teammate gets the same directions on clone. `leglas add` registers a
preview on your machine only, in `.leglas/previews.json`, because
exploration is short-lived and its code lives in a gitignored directory.
`leglas list` shows both and marks which are local.

Renaming a direction in the rail is local in the same way, recorded in
`.leglas/renames.json`. Leglas will not edit your config to rename
something you only renamed for yourself, so the config title stays the
one a teammate sees, and `leglas show` and `leglas keep` take either
name.

## Comparing branches

A preview with a `branch` field is served from its own checkout: Leglas
creates a worktree, installs, starts the app with your `devCommand` on a
free port, and tears it all down when you quit. In the interface it looks
like any other direction, so a branch against your working tree, or three
branches against each other, compares the same way two query parameters
do.

## Without a dev server

Leglas does not require a running app.

If the project exists but nothing is listening, set `devCommand` and
Leglas starts your app itself, proxies it, and stops it on exit. When
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

## How it works

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
implementations behind a query parameter, or a local server against a
deployed one. Absolute URLs load directly rather than through the proxy,
so a site that refuses to be framed will not preview; the interface says
so instead of showing an empty pane.

Leglas also compares what each preview actually draws and warns when two
are identical. This catches a typo like `?v-hero=wavee` that your app
silently ignores while the rail implies a comparison. The check reads the
rendered page, runs only on previews you have opened, and skips
cross-origin previews, which the browser will not let it read.

## Limitations

- Leglas runs no model of its own. Comparing existing routes costs
  nothing, but a new direction is still code your agent writes; Leglas
  hands it the request and shows the result.
- The duplicate check compares rendered markup only, and only when the
  server renders some. Two previews that differ solely in a script are
  reported as identical, and in a fully client-rendered app the check
  says nothing.
- The interface is built for desktop widths.
- Leglas is a development tool. Nothing in it ships to production.

## Development

This repository is a pnpm workspace.

```sh
pnpm install
pnpm build       # build every package
pnpm test        # run the test suite
pnpm typecheck   # type check every package
pnpm site        # build the site, homepage and changelog, into dist/site
```

| Package           | Contents                                           |
| ----------------- | -------------------------------------------------- |
| `packages/server` | Config loading, the proxy, and the local server    |
| `packages/shell`  | The interface, a React application built with Vite |
| `packages/cli`    | The `leglas` binary                                |
| `packages/mcp`    | The `leglas-mcp` stdio server for agent hosts      |

To work on the interface with live reload, run a Leglas server in one
terminal and `pnpm --filter @leglas/shell dev` in another.

Two packages are published, both unscoped: `leglas`, which bundles the
server and the built interface, and `leglas-mcp`. Releases are
tag-driven: set the same version in both packages and `plugin.json`, turn
the changelog's Unreleased section into that version with a title for what
the release was about, push a `v<version>` tag, and CI runs the suite and
publishes through npm trusted publishing. A tag that disagrees with the
manifests is refused, and so is a patch tag when `api-surface.txt` has
moved since the previous one. No npm token exists anywhere in the project.

The [site](https://fredamartey.github.io/leglas/) is two pages, the
homepage and the [changelog](https://fredamartey.github.io/leglas/changelog/),
written by `site.ts`. The changelog page is made from `CHANGELOG.md` and
nothing else, so describing a release in the changelog is the whole job, and
a push to main that touches either publishes through GitHub Pages.

## License

[MIT](LICENSE)
