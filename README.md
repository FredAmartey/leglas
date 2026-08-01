# Leglas

Compare design directions inside your own running app.

Leglas is a local development tool. You point it at a dev server you are
already running, list the URLs you want to compare, and flip between them in
one interface. Every preview is your real application: real data, real
authentication, real behaviour. Nothing is mocked, nothing is cloned, and
your project needs no changes to work with it.

## Requirements

- Node.js 24 or newer, developed and tested against Node 26
- A dev server you can run locally

TypeScript config files rely on Node stripping types natively, which is
available without a flag from Node 23.6. On an older runtime, use
`leglas.config.mjs` or `leglas.config.json` instead.

Leglas never imports or executes your framework, so the target can be Next,
Vite, Remix, Create React App, SvelteKit, Astro, or static output.

## Getting started

Start your dev server as usual, then run Leglas from your project directory:

```sh
npx leglas
```

Leglas starts on port 4100, proxies your app, and opens the interface at
`http://localhost:4100/leglas`. With no configuration it shows a single
preview of your app root, which is enough to confirm the connection.

To compare more than one thing, add a config file.

## Configuration

Create `leglas.config.ts` at the root of the project you want to preview.
`.js`, `.mjs` and `.json` also work. Config resolution walks upward from the
working directory, so in a monorepo the nearest file wins.

```ts
export default {
  devServer: "http://localhost:3000",
  previews: [
    { title: "Current", url: "/" },
    {
      title: "Wave",
      url: "/?v-hero=wave",
      note: "Client artwork, bottom anchored.",
      tags: ["Hero"],
    },
    {
      title: "Dot grid",
      url: "/?v-hero=dotgrid",
      note: "Purple lattice that wakes near the pointer.",
      tags: ["Hero"],
    },
  ],
};
```

| Field | Required | Purpose |
| --- | --- | --- |
| `title` | yes | Label in the rail, and the key for your saved layout |
| `url` | unless `file` | Root relative (`/pricing`) or absolute (`https://staging.example.com`) |
| `note` | no | Second line under the title |
| `tags` | no | The first tag renders as a pill |
| `branch` | no | Preview a git branch instead of the running dev server |
| `file` | no | A project-relative HTML file served by Leglas itself, instead of `url` |
| `devServer` | no | Defaults to `http://localhost:3000` |
| `devCommand` | with `branch` | How to start the app; must contain `{port}`. Also lets Leglas start your own app when nothing is listening |
| `installCommand` | no | Defaults to `npm install` |

Titles must be unique. A configuration error does not stop the server: it
starts anyway and the interface reports what is wrong, so you can fix the
file without hunting through a stack trace.

TypeScript config files are read natively by Node, so there is no compiler,
bundler or extra dependency involved.

## Command line

```text
leglas init                Prepare a project and teach its agents
leglas [options]           Start the server and open the interface
leglas new <surface>       Scaffold a branch point for a surface
leglas explore <surface>   Print distinct angles for an agent to build
leglas classify            Decide where a direction should live
leglas add --title T --url U   Register a preview on this machine
leglas list                Show every preview, shared and local
leglas requests            Collect change requests made from the interface
leglas keep <title>        Keep a winner and end the exploration

  --user-port <port>   Port your dev server is on
  --port <port>        Port for Leglas (default 4100, next free if taken)
  --config <path>      Use this config file instead of searching upward
  --no-open            Do not open the browser
  --json               Print one machine readable envelope
  -h, --help
  -v, --version

  --print              (new) Print the scaffold instead of writing it
  --count <n>          (explore) How many angles, default 3
  --to <path>          (keep) Where the winner should live
  --note <text>        (add) Second line under the title
  --tag <text>         (add) Repeatable
  --branch <name>      (add) Back the preview with a checkout of this branch
  --change <path>      (classify) A file the direction creates or wires up
  --rewrite <path>     (classify) An existing file whose behaviour it must change
```

### Shared and local previews

`leglas.config.ts` is the shared description of a project: commit it, and a
teammate gets the same directions on clone.

`leglas add` registers a preview on your machine only, in
`.leglas/previews.json`. Exploration is short-lived and its code lives in a
gitignored directory, so a teammate must never receive a config entry
pointing at something they do not have. `leglas list` shows both, marking
which are local. Any command that writes into `.leglas/` also makes sure the
directory is gitignored.

### Working with coding agents

`leglas init` writes a section into your project's `AGENTS.md`, creates a
starter config, and ignores the working directory. The section is read by
Cursor, Claude Code and most other agents, and needs no per-user setup: it
travels with the clone, so anyone who opens the repository gets an agent that
already knows how to add design directions to it.

The instruction that matters most in that section is to add directions beside
what exists rather than rewriting it. Asked to make a hero calmer, an agent's
instinct is to edit the hero, and two directions that both rewrite the same
file cannot render from one server. Nothing in Leglas can prevent that,
because it never sees your source, so the contract has to say it.

Every command accepts `--json` and prints a single envelope with a stable exit
code, so an agent can drive the tool without parsing prose.

### Agent hosts that cannot run a shell

`leglas-mcp` is a stdio MCP server exposing the same operations as tools:
`start`, `add`, `list`, `classify`, `explore`, `scaffold`, `keep`,
`requests`, and `init`. It holds no logic of its own; each tool calls
exactly what the CLI calls and returns the same JSON envelope.

Register it in your agent host from the project directory, for example in
Claude Code:

```sh
claude mcp add leglas -- npx -y leglas-mcp
```

or in a `.mcp.json`:

```json
{ "mcpServers": { "leglas": { "command": "npx", "args": ["-y", "leglas-mcp"] } } }
```

The host's working directory names the project, the same contract as the
CLI. The `start` tool boots the viewer and returns the interface URL, and
the server it started stops when the session ends, so a dead host never
leaves a dev server running on a forgotten port.

### When a direction cannot be additive

Most directions are additive: new files beside what exists, rendering from
the dev server you already run. Some genuinely are not. A direction that
changes dependencies, changes build configuration, or only works by
rewriting what an existing file renders cannot share the running server
with its siblings.

`leglas classify` decides which kind you have, before the code is written.
Declare what the direction will touch and it answers with the route and the
reason:

```sh
leglas classify --change package.json --rewrite src/theme.css --json
```

`--change` marks a file the direction creates or wires up; `--rewrite`
marks an existing file whose behaviour it must alter. The answer is either
`in-app`, the ordinary path under `.leglas/variants/`, or `checkout`: build
the direction on its own git branch and register it with
`leglas add --title "Calm" --url "/" --branch <branch>`. Branch-backed
previews need `devCommand` in the config so Leglas can start the checkout,
and they appear in the same rail as everything else.

The escalation is the exception, and it is never silent: isolation costs an
install and a boot, so a direction goes to a checkout only when it names a
reason it cannot sit in the running app.

### Exploring several directions at once

`leglas explore hero --count 6` prints six distinct angles to build, each with
a line naming the obvious approach that would collapse the difference. Left to
itself an agent iterates narrowly around its first idea, so six requests come
back as six shades of one design. The angles vary composition, medium, density,
motion, texture and palette rather than colour alone, and they are ordered for
spread so asking for three still explores widely.

The `AGENTS.md` section tells agents to run this first, so "give me a few
options" reaches for the angles instead of inventing variations of what is
already there.

### Asking for a change without leaving

The tools popover has a field for the direction you are looking at. Type what
you want changed and press Enter: Leglas composes a prompt naming that
direction and the file behind it, copies it to your clipboard, and queues it.

Leglas runs no model of its own. Your agent already knows your conventions,
your design system and your taste, which is context no external worker has, so
it does the work. `leglas requests --json` hands over anything pending and
`leglas requests --clear` empties the queue once it is done. If you would
rather not wire that up, the clipboard copy is the whole feature: paste and
go.

### Scaffolding a surface

`leglas new hero --from src/Hero.tsx` creates a switcher and a first direction
under `.leglas/variants/hero/`, and adds `.leglas/` to your `.gitignore`.

`--from` points at whatever renders that surface today. The baseline then
re-exports that component rather than copying it, so editing the real
component changes the baseline too and you are never comparing against a stale
duplicate of your own code. Without `--from` you get a placeholder to fill in
yourself. The
generated code is ordinary application code: it imports nothing from Leglas,
so removing the tool leaves it working. It also renders the fallback in
production regardless of the URL, so a branch point that reaches a deployed
build cannot expose an unreleased direction.

One step is left to you. Leglas prints the import and the element to use, but
does not edit the component itself, because rewriting a file it does not
understand is how a tool breaks a codebase. Use `--print` to see the scaffold
without writing anything.

`--json` exists so coding agents can drive the tool. It prints a single
object with the interface URL, the resolved port, whether the dev server
answered, and any configuration errors.

## Keyboard

| Key | Action |
| --- | --- |
| Up, Down | Move between directions |
| `\` | Split the stage against the direction you were last on |
| `/` | Focus search |
| `[` | Collapse or open the rail |
| Escape | Clear search, or close the tools popover |

Directions can be renamed, removed, restored and dragged into any order.
Layout is saved per project, so it survives restarts and a change of port.

### Comparing two at once

Flipping shows a difference over time. A split shows it at once, which is what
you want for the last two directions still in contention.

Hover any direction in the rail and press its compare button. It becomes the
right pane, the active direction stays on the left, and the row is marked so
you can see what you are comparing against without hovering. Press it again to
close the split. `\` splits against whichever direction you were looking at
before this one.

The tools widget can be dragged to any corner, since a floating control has a
habit of sitting exactly where you need to look. Its corner is remembered.

Frameworks paint their own dev badge over the running app, which lands on the
same corner and is tooling rather than design. Leglas hides those by default,
and the popover turns them back on. This is done by styling inside the
preview frame, never by altering what the proxy forwards, so what your dev
server sent is what your app receives.

## How it works

Leglas runs a local server that does two things. It serves the interface at
`/leglas`, and it forwards every other request to your dev server. Because
previews load through that proxy, they are same origin with the interface,
which means no CORS configuration and no special cases for cookies.

The proxy is designed to be invisible. Hot module replacement survives the
hop, so editing a file still updates every preview. Redirects that point at
your dev server are rewritten to keep you inside the interface, and
redirects to anywhere else are left alone. Responses stream rather than
buffer. If an app behaves differently through Leglas than it does on its own
port, that is a bug.

## Comparing more than design variants

A preview is a URL, so the same interface compares anything your server can
serve:

- Two implementations of a surface, selected by a query parameter
- Two routes, such as `/pricing` against `/pricing-v2`
- A local server against a deployed one

Absolute URLs load directly rather than through the proxy, so they are
subject to the target's frame policy. A site that refuses to be framed will
not preview, and the interface says so rather than showing an empty pane.

## Starting before you have an app

Leglas does not require a running app.

**If the project exists but nothing is listening**, set `devCommand` in the
config (with `{port}`) and Leglas starts your app itself on a free port,
proxies it, and stops it when you quit, exactly as it does for branch
checkouts. This is reported as status, never asked as a question. When
`--user-port` names a server explicitly, Leglas never starts a different
one behind that flag.

**If there is no app at all**, a direction can be a plain HTML file:

```ts
export default {
  previews: [
    { title: "Aurora", file: ".leglas/pages/aurora.html" },
    { title: "Ember", file: ".leglas/pages/ember.html" },
  ],
};
```

Leglas serves each file itself, from its own origin, so the full rail,
stage, viewports, and split comparison work with no dev server anywhere.
The file's directory is mounted rather than the lone file, so stylesheets
and images beside it resolve normally. `leglas add --title "Aurora" --file
.leglas/pages/aurora.html` registers one from the command line, and the
AGENTS.md section teaches agents the same loop, so "show me three landing
page directions" works in an empty repository. When the real app arrives,
directions graduate to app code and nothing about the interface changes.

## When two directions render the same page

Leglas compares what each preview actually draws and warns when two of them are
identical. This catches the failure that is otherwise invisible: a typo like
`?v-hero=wavee` that your app ignores, serving its default page while the rail
implies you are comparing something.

The comparison reads the rendered page rather than the server's response, so it
works whether your app renders on the server or in the browser. A single-page
app returns the same HTML for every URL, which makes any server-side comparison
useless there.

Previews are compared once they have been opened, and a preview served from
another origin is never compared, because the browser will not let one page read
another origin's content. Nothing here blocks the interface, and it stays quiet
rather than guessing.

## Limitations

Leglas shows design directions. It does not create them. Comparing routes
that already exist costs nothing, but a new direction is still code you or
your agent writes in the app.

Only the rendered markup is compared for duplicates, and only when the server
renders one. Two previews that differ solely in a script are reported as the
same, and in a client-rendered app the check says nothing at all.

The interface is built for desktop widths. It is a development tool and is
not intended to ship in a production runtime.

## Development

This repository is a pnpm workspace.

```sh
pnpm install
pnpm build       # build every package
pnpm test        # run the test suite
pnpm typecheck   # type check every package
```

| Package | Contents |
| --- | --- |
| `packages/server` | Config loading, the proxy, and the local server |
| `packages/shell` | The interface, a React application built with Vite |
| `packages/cli` | The `leglas` binary |
| `packages/mcp` | The `leglas-mcp` stdio server for agent hosts |

To work on the interface with live reload, run a Leglas server in one
terminal and `pnpm --filter @leglas/shell dev` in another. The dev server
proxies the API through to port 4100.

Two packages are published, both unscoped: `leglas`, which bundles the
server and the built interface so one install is the whole tool, and
`leglas-mcp`. Releases are tag-driven. Bump both versions, commit, and
push a `v<version>` tag; GitHub Actions runs the suite and publishes
through npm's trusted publishing, so no npm token exists anywhere in the
project.

## License

MIT
