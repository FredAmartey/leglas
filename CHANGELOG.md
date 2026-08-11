# Changelog

Leglas ships as three things from one repository, and a release moves all
of them together:

- **`leglas`**, the command line tool, on npm
- **`leglas-mcp`**, the MCP server for agent hosts that cannot run a shell, on npm
- **the Agent Plugin**, which is this repository's own directory

They share a version number, so a plugin, a CLI and a server picked up at the
same time are the same release. Each entry says who a change actually reaches,
because most reach only one of the three.

## Unreleased

The interface runs your agent itself. Asking for a change no longer
needs a second terminal: pick an agent once and every request runs as
you send it.

### Added

- **The server runs your agent.** The first request offers the agent
  CLIs found on your machine: Claude Code, Codex, Cursor, or a command
  of your own. Pick one and Leglas spawns it per request, one at a time
  in queue order, with live progress in the composer: which file it is
  editing, a cancel for a run you regret, a retry for one that failed.
  Your agent, your subscription, no keys and no login. (`leglas`)
- **`leglas watch` needs no `--run` once an agent is picked.** The
  choice is shared through `.leglas/watch.json`, and an external watcher
  always wins over the embedded runner, so the two never race for a
  request. (`leglas`)

### Changed

- Browser POSTs to `/leglas/api/` are refused from other origins.
  Loopback, `.local` and private-network hosts stay allowed, so a
  direction link shared on your LAN keeps working. (`leglas`)

## 0.3.0 (2026-08-09)

Leglas becomes installable as one thing. The skill teaches an agent the
workflow, the plugin carries the skill and the server together, and the server
learned to find your project when a plugin client starts it somewhere else.

### Added

- **An installable agent skill.** `npx skills add FredAmartey/leglas` teaches an
  agent the workflow in any project, including ones that have never seen
  Leglas. It sets the project up itself and gets to work.
- **The repository is an [Agent Plugin](https://agent-plugins.org).**
  `plugin.json` and `mcp.json` at the root, the skill in `skills/leglas/`. A
  client that implements the standard picks up the skill and the server
  together. Nothing is built or generated; the directory is the package.
- **An Install section in the README**, saying plainly that there is nothing you
  have to install.
- **The published API is recorded and guarded.** `api-surface.txt` lists what
  both npm packages export. A test compares it against the build, so a changed
  signature turns up in the pull request that caused it, and a release refuses
  a patch tag when the surface has moved.
- **A weekly check on the vendored Agent Plugins schemas**, which opens an
  issue if the published ones change.
- **The plugin manifests are checked against the standard's own schemas**, so a
  typo fails the suite rather than making a client quietly skip a component.

### Fixed

- **The MCP server no longer sets up the wrong directory.** An Agent Plugins
  client starts a plugin's server inside the plugin's own install folder, not
  inside your project. The server used to trust that folder, so `init` wrote
  `AGENTS.md` into a plugin cache and reported success. It now takes the
  project from the workspace the host declares over MCP roots, falls back to
  the working directory only when that sits inside one, and lets
  `LEGLAS_PROJECT_DIR` override both. When nothing answers, the tools say there
  is no project rather than writing somewhere nobody meant.

  If you reach the server through `claude mcp add` or a hand-written
  `.mcp.json`, nothing changes: your working directory is already the project,
  and it is still used.
- **Change requests the agent never collected are no longer cleared**, so
  `--clear` can only drop what was actually handed over.
- **Config edits that need a restart say so**, and unknown `/leglas` paths
  return 404 instead of the interface.
- `npx leglas` works from inside this repository, which the workspace root's
  own name used to prevent.

### Changed

- Commands read as `npx leglas ...` wherever one is suggested, since nothing
  has to be installed first.

### Changed, and only if you import the packages

- `registerLeglasTools` and `startChannel`, both exported from `leglas-mcp`,
  now take `{ project }` where they took `{ cwd }`.

  This is the whole of the breaking change, and it is why this release is
  `0.3.0` rather than `0.2.1`. It does not affect running `npx leglas`, and it
  does not affect calling the MCP tools: those are the same ten tools, with the
  same names and arguments, as in 0.2.0. It affects only code that imports from
  `leglas-mcp` directly, which is an unusual thing to do.

## 0.2.0 (2026-08-05)

Change requests, so you can ask for edits without leaving the comparison.

### Added

- **Ask for a change from the interface.** Type what you want changed on the
  direction you are looking at. Leglas writes a prompt naming that direction
  and the file behind it, copies it to your clipboard, and queues it, with a
  lifecycle the interface can show.
- **`leglas watch --run "<command>"`** hands each request to your agent as it
  arrives, so you can keep working while it acts on them.
- **Channel push.** On hosts that speak channels, the MCP server delivers each
  request straight into the open session instead of waiting to be asked.
- **`leglas show <title>`** answers everything about one direction: its entry,
  the file behind it, its variants, what it is being compared against, and
  anything still pending on it.
- **Directions appear in the rail as an agent registers them**, so you watch a
  set fill in rather than waiting for the whole set.
- **Variants group under the direction they are based on.**
- A logo across the readme, favicon and interface. A keymap on `?` and reworked
  keyboard shortcuts. Loading states, tag colours drawn from the text, and two
  distinct ways to copy a direction.

### Fixed

- The duplicate check sees colour, and scans directions you have not opened yet.
- Tooltips stay inside the viewport, and refit when their label changes while
  open.
- Dragging and tapping the tools widget.
- Copy, rename and remove say whether they worked.

### Changed

- The agent owns the design angles; Leglas prescribes none of them.
- Releases run from CI on a `v*` tag through npm trusted publishing, so no
  token exists anywhere. 0.2.0 onward carry build provenance.

## 0.1.0 and 0.1.1 (2026-08-01)

First release, and a same-day documentation correction. Both were published by
hand before the CI pipeline existed, which is why they carry no provenance and
why the `v0.1.0` tag does not line up with them cleanly.

Point Leglas at the dev server you are already running, list the URLs you want
to compare, and flip between them in one interface. Every preview is your real
application: real data, real authentication, real behaviour.

- The rail, the stage, split comparison, and per-project saved layout.
- `leglas init` writes an `AGENTS.md` section teaching agents the workflow.
- `leglas new`, `explore`, `classify`, `add`, `list` and `keep`.
- `leglas-mcp` for agent hosts that cannot run a shell.
- Branch-backed previews, plain HTML directions with no dev server, and a
  duplicate check for two directions that render the same page.
