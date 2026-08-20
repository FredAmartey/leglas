# Changelog

Leglas ships as three things from one repository, and a release moves all
of them together:

- **`leglas`**, the command line tool, on npm
- **`leglas-mcp`**, the MCP server for agent hosts that cannot run a shell, on npm
- **the Agent Plugin**, which is this repository's own directory

They share a version number, so a plugin, a CLI and a server picked up at the
same time are the same release. Each entry says who a change actually reaches,
because most reach only one of the three.

## 0.5.0 (2026-08-20)

This is a minor rather than a patch because the public API surface moved:
`PendingRequest.status` gained two values, and the type gained `failure`,
`mode` and `notes`.

### Added

- **Point at what is wrong instead of describing where it is.** Press `A`, or
  use the Annotate chip beside the send button, and the preview turns into a
  picker: hovering outlines the element under the pointer, clicking drops a
  numbered pin and takes a note, and dragging marks an area and names every
  element it covers. The page still scrolls while the mode is on, so what is
  below the fold is as reachable as what is not. Annotations alone are a
  complete request, so the composer can be left empty; what it does take is
  the sentence about the change rather than the paragraph about which element.
  Each one carries the element's own words, its tag and classes, a CSS path
  and the rectangle it filled, and the request tells the agent which of those
  to trust as the design moves under them. One whose element has gone says so
  rather than pointing confidently at the wrong thing. The card that takes the
  words keeps clear of what it is asking about, flipping and shifting at the
  edges of the pane rather than hanging off them. They live in
  `.leglas/annotations.json`, and a change made in place forgets the ones it
  answered. (`leglas`)
- **A change makes a variant instead of overwriting the direction.** Sending
  "the pouch looks fake" at a direction used to edit that direction's file, so
  the thing being compared against was gone. It now builds a new direction
  from a copy of the parent, registered under it in the rail with the parent
  as its default comparison. A chip beside the send button switches to
  changing the direction itself, for the times a change really is a fix.
  (`leglas`)
- **A direction says where it came from.** Hovering a row shows its note in
  full, the direction it was built from, and the change that was asked for in
  the words that were typed. The selected direction carries the same line
  under the composer without being hovered. Registration takes it as
  `leglas add --asked-for`, which the `add` MCP tool exposes too. (`leglas`,
  `leglas-mcp`)

### Fixed

- **Embedded Codex changes keep their quality without paying orchestration
  tax.** Leglas still respects the user's selected model and reasoning effort,
  but Codex can now reach the live localhost preview from its workspace
  sandbox. Interface-generated requests say that exploration, collection and
  server startup are already complete, and registration calls the exact
  running Leglas CLI instead of asking `npx` to discover and possibly fetch a
  package. This removes the cache probes, duplicate dev-server attempts and
  version hunt that could turn a small design edit into a multi-minute run.
  (`leglas`)

- **Codex works in a project that is not a git repository.** `codex exec`
  refuses such a directory before it reaches a model, so every Codex request
  in one failed with nothing in the interface to say why. Each codex argv now
  carries `--skip-git-repo-check`, which moves that precondition and nothing
  else: writes stay confined by `-s workspace-write`. (`leglas`)
- **A stopped run is recorded as stopped.** Cancelling used to leave the
  request looking exactly like a failure, offered back for a rerun, and only
  in the server's memory: a restart read it as `picked-up` and the card said
  "your agent is on it" forever. Stops and failures are now written into the
  queue and told apart on the card. (`leglas`)
- **A failed change says what went wrong.** "That change failed" is now
  followed by the reason: you stopped it, the provider was overloaded, the
  CLI is signed out, its command is gone, Codex refused the directory. The
  agent's own output stays in the terminal running Leglas rather than being
  piped into the browser. (`leglas`)
- **A run waiting on an overloaded provider says so.** Claude retries a 529
  ten times over roughly 200 seconds without a word; the card now reads
  "provider is overloaded · retry 4 of 10" instead of a spinner. Leglas does
  not shorten or kill the vendor's backoff, so a run that recovers still
  finishes. (`leglas`)
- **A stopped agent cannot wedge the runner.** A child that ignores SIGTERM,
  or whose own child outlives it holding the output pipe, never reported that
  it had closed: the run stayed "running" and everything queued behind it
  waited forever. A stop now escalates after five seconds and the queue moves
  on. The same wait bit the agent auth probe, which could leave
  `/leglas/api/agents` unanswered for the life of the server. (`leglas`)
- **A failed request no longer costs two provider turns.** A resumed session
  that died was always rerun cold. That is right for a session the vendor
  cleaned up, and wrong for an outage: it aimed a second full retry ladder at
  a provider that was already down. Only a failure with no other explanation
  earns the rerun now. (`leglas`)
- **The same change cannot be queued twice by accident.** Sending identical
  words at the same direction while one is still waiting is refused with a
  line saying so; anything else still queues, and the composer stays open
  during a run. (`leglas`)

## 0.4.1 (2026-08-14)

### Added

- **Removed directions can be deleted for good.** The removed list now has a
  per-direction Delete action and a Clear all action, both behind a
  confirmation. Machine-local directions leave `.leglas/previews.json` while
  shared config and preview source files stay untouched. (`leglas`)

### Fixed

- **A direction can be dragged from anywhere on its row.** Vertical movement
  reorders while horizontal movement still selects text, so the note no longer
  leaves most of the row unable to drag. (`leglas`)
- **Rename fields keep Enter and Space.** The row keyboard shortcut now runs
  only when the row itself has focus, so Enter submits a rename and spaces can
  be typed into its name. (`leglas`)
- **An unreadable local registry no longer hides working directions.** Leglas
  keeps the previews it booted with if `.leglas/previews.json` becomes invalid
  or unreadable. (`leglas`)
- **Delete confirmations keep keyboard focus contained.** Focus stays inside
  the dialog until it closes, then returns to the control that opened it.
  (`leglas`)

## 0.4.0 (2026-08-13)

The interface runs your agent itself. Asking for a change no longer
needs a second terminal: pick an agent once and every request runs as
you send it.

### Added

- **The server runs your agent.** The composer carries its own agent
  picker, the way a chat carries a model picker: the CLIs found on your
  machine (Claude Code, Codex, Cursor, or a command of your own) sit one
  click away beside the send button. Pick one and Leglas spawns it per
  request, one at a time in queue order. Each run reports in a card
  above the field: who is working, which file they are touching, a
  ticking clock, a stop button while it runs, retry and dismiss when it
  fails. Your agent, your subscription, no keys and no login. (`leglas`)
- **The picker knows who is signed in.** Each detected CLI is asked for
  its own login status (`claude auth status`, `codex login status`), so
  a signed-out agent is marked in the menu before a run fails instead
  of after. The answer is cached and refreshed behind the scenes; no
  request waits on it twice. (`leglas`)
- **Any command is an agent.** The picker's "Add your own" entry takes
  the command you already run: aider, goose, a script of your own. Your
  request is handed to it as its last argument, so there is no syntax
  to learn; `{prompt}` still places it elsewhere for the command that
  needs that, in the menu and in `leglas watch --run` alike. The chip
  wears the command's own name, and the run loop treats it exactly like
  the built-in three. (`leglas`)
- **`leglas watch` needs no `--run` once an agent is picked.** The
  choice is shared through `.leglas/watch.json`, and an external watcher
  always wins over the embedded runner, so the two never race for a
  request. (`leglas`)
- **Consecutive requests share the agent's session.** The first request
  pays for reading the project; the ones after it resume the same
  conversation (`codex exec resume`, `claude --resume`) and skip
  straight to the change, measured 25 to 40 percent faster. A session
  ends on any failure, stop, or after eight turns, and a resume the
  vendor no longer remembers falls back to a fresh start on its own,
  so nothing new can break a request. (`leglas`)
- **Connect the agents Leglas cannot spawn.** The picker's "Connect
  another agent" entry hands out the MCP wiring for IDE panels and chat
  hosts: the Claude Code command or an `mcp.json` entry, one copy each.
  An agent working the queue over MCP now counts as attached, so the
  embedded runner stays out of its way while it works and takes back
  over once it goes quiet. (`leglas`, `leglas-mcp`)

### Changed

- **Runs start the moment you send and finish in half the time.** A new
  request no longer waits out the runner's poll, and the composed prompt
  now says how small the job is, so the agent makes the change and
  finishes instead of verifying a design tweak with test runs. Measured
  on real runs: the typical small change went from about a minute with
  two-minute outliers to under thirty seconds. (`leglas`)
- Writing to `/leglas/api/` now happens only from the machine running
  Leglas: every POST needs a loopback socket, and the browser's Origin
  must match its Host on top of that. An API that decides what executes
  on your computer cannot take instructions from the network. Shared
  links keep working for what they promised, opening and viewing live
  directions. (`leglas`)

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
