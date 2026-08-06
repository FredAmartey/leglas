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
</p>

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
  precise request for your agent, file path included. Leave
  `leglas watch --run "claude -p {prompt}"` running in another terminal
  and your agent picks each request up as you send it. In Claude Code,
  the Leglas MCP server can also push each request straight into your
  open session as a channel event (channels are a research preview:
  start Claude Code with `--dangerously-load-development-channels
  server:<your leglas server name>`).
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

It works with whatever you're building in. Leglas never imports or
executes your framework, so the target can be Next, Vite, Remix,
SvelteKit, Astro, or a folder of static files. Requires Node 24 or
newer.

## Working with coding agents

The fastest way in is the agent skill:

```sh
npx skills add FredAmartey/leglas
```

One install, and your agent recognises "give me a few directions for the
pricing page" as a Leglas exploration in any project, including ones
that have never seen Leglas. It sets the project up itself and gets to
work.

In a project, run `leglas init` once. It writes a section into your
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

- `leglas explore hero --count 6` briefs the exploration: what the set
  is for, why it only works if the six genuinely disagree, and how each
  direction registers. Unbriefed, six requests come back as six variants
  of one idea. With `--based-on "Aurora"` the goal flips: six deliberate
  variants of a direction you already like, and drifting into a new
  direction is the failure. The designs themselves are the agent's;
  Leglas prescribes none.
- `leglas new hero --from src/Hero.tsx` scaffolds a switcher under
  `.leglas/variants/hero/`. With `--from`, the baseline re-exports your
  real component, so you never compare against a stale copy. Leglas
  prints the one line to add in your component and does not edit it,
  because rewriting a file it does not understand is how a tool breaks a
  codebase. Scaffolded branch points return the fallback in production
  builds, so a committed one cannot expose an unreleased direction.
- `leglas classify --change package.json --rewrite src/theme.css` answers
  where a direction should live before it is written. Changing
  dependencies, build configuration, or an existing file's behaviour
  cannot be additive, so those directions build on their own git branch
  and register with `leglas add --branch`. Everything else stays in-app,
  where switching is instant.
- `leglas show "Aurora" --json` answers for one direction: its entry, the
  source file behind it, the variants based on it, what it is being compared
  against, and anything still pending on it. Copying a direction from the
  rail hands over a block that ends in this command, so an agent given the
  block can go and get the rest.
- `leglas keep "Aurora" --to src/components/hero.tsx` moves the winner
  into real source and ends the exploration.

Asking for a change works from the interface too. Type what you want
changed into the field under the rail (or press `R`) and Leglas composes a
prompt naming the direction and the file behind it, copies it to your
clipboard, and queues it. The direction it means is the one highlighted
directly above the field. Your agent drains the queue with `leglas requests --json` and clears
it with `--clear`. Leglas runs no model of its own; your agent already
knows your conventions and your taste.

### MCP server

For agent hosts that cannot run shell commands, `leglas-mcp` exposes the
same operations as MCP tools over stdio: `start`, `add`, `list`, `show`,
`classify`, `explore`, `scaffold`, `keep`, `requests`, and `init`. Each
tool calls exactly what the CLI calls and returns the same envelope.

```sh
claude mcp add leglas -- npx -y leglas-mcp
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "leglas": { "command": "npx", "args": ["-y", "leglas-mcp"] } } }
```

The host's working directory names the project. The `start` tool boots
the viewer and returns its URL, and anything it started stops when the
session ends.

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
| `devServer`      | no            | Defaults to `http://localhost:3000`                                     |
| `devCommand`     | with `branch` | How to start the app. Must contain `{port}`.                            |
| `installCommand` | no            | Defaults to `npm install`                                               |

A broken config never stops the server. Leglas starts anyway and the
interface reports what to fix, so you are not hunting through a stack
trace.

## The interface

Directions live in a rail on the left. The stage shows the active one in
a framed viewport at Full, 1440, 834, or 390 wide. Rename, reorder, hide,
and tag directions from the rail; layout is saved per project and
survives restarts and port changes.

Flipping shows a difference over time. A split shows it at once, which is
what you want for the last two directions in contention: press `C`, or
hover a direction and press its compare button, and it becomes the right
pane while the active direction holds the left.

Arrows move between directions, `1` to `9` jump straight to one, `R` asks
for a change to the one you are on, `Cmd K` (`Ctrl K` elsewhere) searches
and `B` collapses the rail. Press `?` for the whole keymap.

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
leglas init                Prepare a project and teach its agents
leglas [options]           Start the server and open the interface
leglas new <surface>       Scaffold a branch point for a surface
leglas explore <surface>   Brief an agent's exploration of a surface
leglas classify            Decide where a direction should live
leglas add --title T --url U   Register a preview on this machine
leglas list                Show every preview, shared and local
leglas show <title>        Everything Leglas knows about one direction
leglas requests            Collect change requests made from the interface
leglas keep <title>        Keep a winner and end the exploration

  --user-port <port>   Port your dev server is on
  --port <port>        Port for Leglas (default 4100, next free if taken)
  --config <path>      Use this config file instead of searching upward
  --no-open            Do not open the browser
  --json               Print one machine-readable envelope

  --print              (new) Print the scaffold instead of writing it
  --from <path>        (new) Use an existing component as the baseline
  --count <n>          (explore) How many directions, default 3
  --based-on <title>     (explore) Variants of an existing direction instead of new ones
  --based-on <title>     (add) The direction this preview is a variant of; groups the family
  --change <path>      (classify) A file the direction creates or wires up
  --rewrite <path>     (classify) An existing file whose behaviour must change
  --note <text>        (add) Second line under the title
  --tag <text>         (add) Repeatable
  --branch <name>      (add) Back the preview with a checkout of this branch
  --file <path>        (add) An HTML file served by Leglas itself
  --to <path>          (keep) Where the winner should live
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

- Leglas shows directions; it does not create them. Comparing existing
  routes costs nothing, but a new direction is still code you or your
  agent writes.
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
tag-driven: bump both versions, push a `v<version>` tag, and CI runs the
suite and publishes through npm trusted publishing. No npm token exists
anywhere in the project.

## License

[MIT](LICENSE)
