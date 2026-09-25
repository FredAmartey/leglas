# Working with agents

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

## Give this to your agent

Paste this into any agent that can run commands, in the project you want
directions for. It installs the skill and takes it from there.

```prompt
Install the Leglas skill with `npx skills add FredAmartey/leglas`, then read it and set this project up the way it says. From now on, when I ask for a few directions for a page, build them with Leglas so I can compare them in the browser.
```

## Add beside, never rewrite

The instructions center on one rule. Two directions that rewrite the same
file cannot render from one server, and asking an agent to "make the hero
calmer" tempts it to edit the hero. So a direction is added next to what
exists: a switcher scaffolded beside your component, a query parameter
that selects it, and your real component untouched as the baseline.
Anything that cannot be additive, a dependency, a build change, an
existing file's behaviour, builds on its own git branch instead.

## What an agent runs

| Command | What it does |
| --- | --- |
| `leglas explore <surface> --count 6` | Briefs the exploration: what the set is for, and why it only works if the six genuinely disagree. `--based-on "Aurora"` flips it to six deliberate variants of one you like. The designs are the agent's; Leglas prescribes none. |
| `leglas new <surface> --from src/Hero.tsx` | Scaffolds a switcher under `.leglas/variants/`, with the baseline re-exporting your real component. Prints the one line to add and does not edit your file. Scaffolded branch points return the fallback in production builds. |
| `leglas classify --change … --rewrite …` | Says where a direction should live before it is written: in-app, where switching is instant, or on its own branch. |
| `leglas add --title … --url …` | Registers a direction on this machine. |
| `leglas show "Aurora" --json` | Everything about one direction: its entry, the file behind it, its variants, what it is compared against, what is pending. `--screenshot` renders it too, so an agent can look at what it built. |
| `leglas requests --json` | The change requests queued from the interface; `--clear` acknowledges them. |
| `leglas keep "Aurora" --to src/components/hero.tsx` | Moves the winner into real source and ends the exploration, writing what it decided into `design-log/` as markdown and PNGs. `leglas log` lists what is there. |

The full list of commands and the flags they share is in
[Command line](cli.md).

## Running requests

Requests made from the interface wait in a queue. An agent picked in the
interface drains it on its own. In a terminal, `npx leglas watch` is the
same loop with the agent's own output in view, and needs no flag once an
agent has been picked; for a CLI that is not in the picker, keep the
command explicit:

```sh
npx leglas watch --run "my-agent {prompt}"
```

When the interface runs the agent, a run that goes quiet is told apart from
one that is working. After three minutes without a line of output the card
says how long it has been quiet; after thirty, Leglas ends the run and says
why, so a question the agent is stuck on, which nothing here can answer,
never holds up the changes queued behind it. Anything the agent prints
resets both, so a long build or a model thinking hard is never cut short,
and a run ended this way is not retried on its own.

## MCP server

For agent hosts that cannot run shell commands, `leglas-mcp` exposes the
same operations as MCP tools over stdio: `start`, `add`, `list`, `show`,
`classify`, `explore`, `scaffold`, `keep`, `requests`, `share` and `init`. Each
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

## Agent Plugin

The repository is also an [Agent Plugin](https://agent-plugins.org), the
open standard for shipping a skill and MCP configuration together, so a
client that implements it installs both in one step. It is a layout, not a
build: `plugin.json` and `mcp.json` at the root, the skill in
`skills/leglas/`. Such a client starts the server in the plugin's own
directory, so the project is taken from `LEGLAS_PROJECT_DIR` when it is
set, and otherwise from the workspace the host declares over MCP roots. The
plugin's version covers the skill and the configuration; the server it
launches is whatever `npx` fetches, the same as every command above.
