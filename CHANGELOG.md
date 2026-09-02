# Changelog

Leglas ships as three things from one repository, and a release moves all
of them together:

- **`leglas`**, the command line tool, on npm
- **`leglas-mcp`**, the MCP server for agent hosts that cannot run a shell, on npm
- **the Agent Plugin**, which is this repository's own directory

They share a version number, so a plugin, a CLI and a server picked up at the
same time are the same release. Each entry says who a change actually reaches,
because most reach only one of the three, and each release heading says what
it was about.

## Unreleased

### Changed

- **The rail shows where each direction came from.** A rail of eight rows read
  as eight siblings even when the head said four directions and a chain of
  passes on one of them, because every variant was flattened under its family
  root in saved order. The rail now keeps lineage order: each variant follows
  the direction it was made from, and a gutter beside the titles draws the
  family the way `git log --graph` draws a history, with a lane per branch and
  a fork where a later sibling leaves the line. Dots mark where a line starts,
  ends or forks; a ring marks the row on stage. The line from a direction's
  root down to it carries a slow current of colour and a soft surge every few
  seconds, and resting on a row or on a crumb aims it there; the crumbs under
  the composer say the same ancestry in words, and clicking one goes there,
  shift-click compares against it. Reordering holds a row among its siblings:
  drag one and the families around it fold away for the drag, a family
  travels as one row behind its root, and a row pushed past its siblings says
  why on the way and again when it is let go. Folding a family is a view
  transition; a new direction blooms where it lands. With less motion asked
  for, the line is still coloured and nothing moves. (`leglas`)

### Fixed

- **A variant of a captured page came back with unwanted elements from its
  parent.** Fork the served HTML of a page that rebuilds itself in the browser
  (a captured production site, a static export, any hydrating app served as a
  file) and the parent's hero, logo and buttons showed up in the variant for a
  few seconds after every load, or for good: the framework rebuilt the page
  from the parent's JavaScript, and the agent's only evidence was one line
  lost under the console error cap. The capture now keeps that line whatever
  else the page logged, the request tells the agent the page rebuilds itself
  and that the change belongs where its JavaScript gets what it renders (a
  per-direction override with the original as default, which the additive
  rule now names as allowed), and `leglas show` reports it. Directions
  switched in components were never affected.
  (`leglas`, `leglas-mcp`, plugin)

## 0.8.0 (2026-08-28): An exploration writes down what it decided

A minor, because the public surface moved: an exploration now writes
down what it decided, and `leglas log` reads it back.

### Added

- **An exploration writes down what it decided.** Everything an exploration
  produces was thrown away when it ended: the directions with their notes, the
  words typed at each of them, the captures the agent was sent, and which one
  won. That is right for the working files, which is why `.leglas/` is
  gitignored, and wrong for the record. `leglas keep` now writes an entry to
  `design-log/` first: plain markdown and PNGs, committed, so a pull request
  can link it and somebody can read it in three months without this tool.
  Nothing is invented; a direction with no note gets no note. A change that
  failed is listed once, at the foot, with why, rather than reading as though
  it happened. `leglas log` lists what is there and prints one entry, and the
  instructions Leglas writes for agents now tell them to read it before
  exploring a surface, so nobody proposes a direction that was already
  rejected. Set `logDir` to put it somewhere other than `design-log`.
  (`leglas`)

![A design-log entry as GitHub renders it: hero, 2026-08-28; Table won and became src/hero.tsx, 8 directions were compared; then the Table section with its capture and the words that were asked for it](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.8.0-design-log/design-log-entry.jpg "What leglas keep writes before it clears the exploration: the winner, every direction with its note and its capture, and the words typed at each of them.")


### Changed

- **A branch stops when nobody is looking at it.** 0.7.4 made a branch preview
  start when you open it. Nothing stopped one afterwards, so a branch opened
  once held a checkout and a dev server until the session ended. Ten minutes
  without traffic and it is stopped and its checkout removed; opening it starts
  it again. A branch still serving, including one holding a live-reload
  connection, is left alone, and one that is still starting is never touched.
  (`leglas`)
- **The interface stops asking for answers it already has.** `/api/config`,
  `/api/requests`, `/api/annotations` and `/api/health` answered in full every
  time, and an idle tab reads them sixteen times a minute, almost always
  unchanged. They carry an ETag now and answer 304 to a matching revalidation,
  which on a small project is about 1.25KB a tick down to headers alone. One
  combined endpoint would cut the request count further and was not done: the
  four would then share a failure, so a slow health probe would hold up the
  queue. (`leglas`)

### Fixed

- **A branch preview served nothing but 502.** Its dev server is reached
  through a proxy so Leglas can tell when it was last looked at, and the proxy
  dialled the address exactly as `URL.hostname` gives it, brackets and all. A
  branch binding IPv6, which is Vite's default on macOS, has an origin of
  `http://[::1]:PORT`, and `[::1]` is not a name: every lookup answered
  ENOTFOUND. (`leglas`)

## 0.7.4 (2026-08-27): Branches start when you open them

A patch: a branch preview is checked out when you open it rather than
when Leglas starts, so a project with branches is usable in a second
instead of ten.

### Changed

- **A branch preview starts when you open it, not when Leglas does.** A branch
  is a whole second copy of the project: checked out, installed and served.
  Every one of them was brought up before the interface appeared, in sequence,
  whether or not anybody opened one, and the README's own pitch is comparing
  seven of them. On a small project with two, that was 8.3s of waiting and
  272MB of checkouts before anything was on screen. Opening one is the trigger
  now, so the interface is up in 1.6s and only the branch you look at costs
  anything. The pane says where its checkout has got to while it runs, a
  failure says why and offers to try again, and asking twice joins the one
  start rather than checking out twice. The rail shows a branch preview's
  branch instead of its URL, which was a loopback address on a port picked at
  random. (`leglas`)

![The pane of a branch preview while it starts: a spinner, the line Installing what it needs, and under it A branch runs in its own checkout, built the first time you open it this session](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.7.4-branch-starts-when-opened/installing-what-it-needs.png#w=500 "Opening a branch is what starts it, and the pane says which step it is on: checking out, installing, starting its dev server.")


## 0.7.3 (2026-08-27): Branch previews on a default Vite project

A patch: branch previews could not start at all on a project whose dev
server binds IPv6, which is the default one.

### Fixed

- **Branch previews could not start at all, on a default Vite project.** The
  wait for a dev command to come up connected to `127.0.0.1` and nothing else.
  A dev server told to serve `localhost` binds whatever the machine resolves
  that to, and on current macOS and Node that is `::1` first, so Vite's default
  listens on IPv6 alone. Every branch waited out its full ninety seconds
  against a server that had been answering since its first second, then was
  reported as not serving the port it was given, which it was, and its checkout
  was deleted. The wait now tries both loopback addresses and builds the
  preview's URL from whichever one answered, since reporting `127.0.0.1` for a
  server bound to `::1` moves the failure later and further from its cause.
  The same wait starts a project's own app when the config carries a
  `devCommand`, so that path was equally affected. (`leglas`)

## 0.7.2 (2026-08-27): The server says when

A patch: the interface stops polling on a timer and the server says
when instead. Nothing a caller uses changes, and the public surface
does not move.

### Changed

- **The interface stops asking.** Three loops used to poll on a timer: the
  config every 3s, the queue and its annotations every 2s, health every 3s.
  A tab sitting idle with nobody touching it made 100 requests a minute and
  moved 108KB, almost all of it answered no. The server now says when, over
  one websocket at `/leglas/api/live`, and the shell keeps the reads it
  already had. A frame names what changed and nothing else, so the queue file
  stays the durable record and push is latency rather than truth. Idle cost
  falls to 16 requests and 8KB a minute, and a direction an agent has just
  registered reaches the rail in about 223ms rather than waiting up to 3s for
  a tick to notice it. Measured with resource timings on both ends; summing
  response bodies instead gives about 22KB for the same before-minute. A
  dropped socket falls back to a slow read every 15s, so it degrades slower
  rather than wrong, and the three loops keep independent fallbacks rather
  than sharing one read, since a single slow endpoint should not become every
  loop's problem. (`leglas`)

## 0.7.1 (2026-08-27): The route the guard never saw

A patch: a request body of four characters could end the server, on the one
route the guard that closed that hole never saw.

### Fixed

- **A malformed body could still take the server down, on one route.** 0.7.0
  folded every body-reading route onto one reader that refuses anything which
  is not a JSON object, and shipped `POST /api/capture` in the same release,
  written to the old hand-rolled pattern. Four characters sent to loopback,
  `null`, ended the process: the interface, the queue's own writer and
  whatever run was under way. `/api/annotations/update` had the same shape,
  though it repeated the check inline and so was never exploitable. Both use
  the reader now. (`leglas`)
- **The guard's test could not see a route nobody told it about.** It worked
  from a hardcoded list, so a route written after the list was added was
  simply absent, which is how the hole came back inside one release. The
  routes are read out of the server now, so a new POST route is covered the
  moment it is written, and the two that genuinely take something else carry
  a named reason rather than being silently missing. A source scan fails if
  any route parses a body by hand again. (`leglas`)

## 0.7.0 (2026-08-27): The agent sees what you see

Every change request carries what the user sees, and embedded agents warm up
when you mean it. A minor: how every run starts changed underneath, `leglas`
gained an optional dependency, and the public surface moved.

### Added

- **Every change request carries what the user sees.** Sending a change from
  the interface renders the direction with a headless browser found on the
  machine (Chrome, Chromium, Brave, Edge, Arc, or a Playwright or Puppeteer
  cache; `LEGLAS_BROWSER` overrides) at the width the design is drawn at, and
  files the PNG under `.leglas/captures/<request>/` beside a crop of each
  note, the compared direction when the stage is split, and any reference
  images attached in the composer. The prompt names every file and says what
  each one is, and console errors logged on load ride along as text. The
  embedded Claude session receives the images as content blocks, the embedded
  Codex app-server as `localImage` inputs, and a cold Codex run gets `-i` per
  image. Every other way in, a Claude CLI fallback, Cursor, a custom command
  and `leglas watch`, gets the paths in the prompt and is told to open them. With no browser on the machine the request still goes, with one
  sentence saying why nothing was captured. Captures leave with their request
  and orphans are pruned at boot. (`leglas`)

![The composer a moment after sending: the field is disabled, a reference thumbnail sits above it, and the hint reads Capturing the design for your agent](https://raw.githubusercontent.com/FredAmartey/docs-assets/377e0b3810067971eee37f8f940c9bf690b256fa/projects/leglas/pull-requests/0032-agent-eyes/composer-capturing.png#w=480 "Send, and the direction is captured for the agent first; a reference image attached to the composer rides along.")

- **Reference images in the composer.** Paste, drop or attach up to four PNG,
  JPEG, WebP or GIF images of 10MB or less to a change. They upload as they
  are attached and ride with the request. (`leglas`)
- **`leglas show <title> --screenshot`** renders a direction and prints the
  PNG's path. `--width` picks the viewport, 320 to 3840, and `--port` names a
  Leglas other than the one `.leglas/server.json` records. The MCP `show` tool
  takes `screenshot: true` and returns the image. The agent instructions
  `leglas init` writes, the explore brief and the skill now ask for one look
  at each direction before it is called done, and a composed request asks the
  agent to look once after the change. (`leglas`, `leglas-mcp`, plugin)

![A rendered direction: a dark landing page whose headline reads Catch it while it's still humming, over orange sound waves](https://raw.githubusercontent.com/FredAmartey/docs-assets/377e0b3810067971eee37f8f940c9bf690b256fa/projects/leglas/pull-requests/0032-agent-eyes/what-the-agent-received-frame.png "What one request handed the agent: the direction at the width it was drawn at, filed under .leglas/captures/.")

- **`.leglas/server.json`** records the running server's port so a second
  process can find it. Removed when the server stops, and only by the instance
  that wrote it. `/leglas/api/health` also names the project directory it
  serves, so a command pointed at the wrong Leglas is told so instead of
  capturing someone else's direction. (`leglas`)

- **A direction says when an agent is working on it.** Its row in the rail
  carries a working badge while an agent has the request in hand, and not
  before: a request that is only queued shows nothing on the row, so the
  badge means work under way rather than work waiting. (`leglas`)
- **An annotation opens again.** Click a pin and the card it was written in
  comes back with the words in it, ready to be reworded or dropped. Enter
  saves, Escape closes and `Forget it` is a button in the card. Dropping a
  note used to live on the hover label beside the badge, with a gap between
  the two that ended the hover on the way across, so removing a pin meant
  aiming at a target that kept vanishing. Nothing you have to reach now lives
  in a hover state, the badge takes a larger hit area than it draws, and
  pins answer the keyboard. (`leglas`)
- **A pin says when its words are already with an agent.** A note carried by
  a change that has been sent and has not settled takes a ring, and its card
  says the same in words. The prompt is composed when you press send, so
  rewording such a note is about the next change rather than the one in
  flight, and a pin that had been read looked exactly like one that never
  had. Rewording one hands it a new identity, because a change forgets the
  notes it answered as it lands and would otherwise take the new words down
  with the old. (`leglas`)

### Changed

- The Claude Code allowance a composed request carries covers `leglas show` as
  well as `leglas add`. (`leglas`)

- **Embedded Claude runs now use one persistent Agent SDK session, warmed
  when you mean it.** Leglas starts the Claude process when the composer takes
  focus or an agent is chosen, keeps its native process and context alive
  across bounded turns, applies the user's chosen effort per turn and maps
  stop to the SDK interrupt. Claude's model, project/user settings, tools
  and edit permissions remain authoritative. Nothing is warmed at startup and
  only one vendor is ever warm, because a warm session is Claude Code plus
  every MCP server your settings configure: measured at 591MB across eight
  processes on a machine with six of them, held for a session that may never
  send a request. Five idle minutes let that process go, and the next time you
  aim at the composer it comes back with the same conversation loaded, so a
  follow-up still knows what came before. If the optional SDK cannot load
  or initialize, Leglas falls back to the existing `claude -p` path. The SDK
  is an optional dependency of `leglas`, so an install that cannot fetch it
  still gets a working Leglas. (`leglas`)
- **Embedded Codex runs stay warm between requests, on the same terms.**
  Leglas warms one Codex app-server process on the same signals, starts and
  resumes threads through its streamed protocol and maps cancellation to a
  turn interrupt. The selected model, effort, project instructions, tools,
  workspace-write boundary and live preview access are unchanged. It idles
  out like Claude and picks its thread back up when it returns. Older Codex
  builds or a failed app-server handshake fall back to the existing
  `codex exec` path. (`leglas`)
- **Cursor continues its chat between requests.** `cursor-agent` has no
  persistent transport to hold open, so its process still starts per request,
  but Leglas now records the session each run reports and resumes it on the
  next one, which is the saving the other two get from a warm session: the
  repository survey happens once instead of every time. (`leglas`)

### Fixed

- **A screenshot browser no longer outlives the Leglas that started it.**
  Closing the terminal window sends SIGHUP, which Node acts on by exiting at
  once, so the shutdown never ran and the headless browser was reparented to
  init: 114MB across two processes, invisible because it is headless, held
  until the machine restarted. That signal is handled now. A Leglas killed
  outright or crashing cannot run any handler, so each browser also records
  who launched it and how to reach it, in a profile directory only its own
  user can read, and the next Leglas closes the ones whose owner is gone by
  asking them over their own debugging endpoint. Nothing is signalled by
  process id, since a process id is reused and the browser that answers a
  token is the one that minted it. A browser belonging to a second Leglas
  running right now is left alone, and so is a profile belonging to another
  user of the machine. (`leglas`)
- **Flipping between directions no longer loads every one of them twice.**
  The duplicate check reads each direction off stage once, but opening one
  looked like its document had been replaced, so the direction just clicked
  was read again in a hidden frame: every flip cost two loads of the app
  instead of one. Ten flips against a Next dev server went from 25 page
  compiles to 9. Asking for a variant no longer forgets the verdict of the
  direction it was asked of either, since a variant is built beside it and
  leaves it alone, and the check pauses while the tab is in the background.
  (`leglas`)
- **Requests the browser gave up on are dropped at the dev server too.** When
  a preview unmounts or the duplicate check moves on, the proxy now ends the
  matching upstream request instead of letting it run to completion into a
  response nobody will read, holding a connection the whole time. (`leglas`)
- **The interface no longer re-renders every three seconds.** The dev-server
  health poll folded an unchanged answer into new state on every beat. A
  direction's duplicate signature is also a short digest now, rather than the
  megabyte of sampled layout it was read from. (`leglas`)
- **Cursor says what it is doing.** Its activity was read as though its output
  had Claude's shape, so every tool call read as nothing: a Cursor run showed
  no file it was touching, and Leglas could not tell that it had edited
  anything. Its own event shape is read now, and because those shapes are
  taken from Cursor's documentation rather than checked against the CLI,
  Leglas no longer reruns a failed Cursor request on its own: not being seen
  to edit is not evidence that nothing was edited. (`leglas`)
- **`leglas watch` could ignore a stop.** The watcher registered its stop
  handler after resolving the agent and writing the template, so a stop that
  arrived inside that window was never heard: the loop kept running and the
  caller waited on it for good. A stop that lands during startup now stops it.
  (`leglas`)
- **A malformed request body no longer takes the server down with it.** Every
  route that reads one now refuses anything that is not a JSON object. `null`
  is valid JSON, and reading a field off it threw where nothing was waiting to
  catch it, which on Node's terms ends the process: the interface, the queue's
  own writer and whatever run was under way, from four characters sent by
  anything that could reach loopback. (`leglas`)

- **One Escape backs out one step while annotating.** The card's field and
  the layer both answered the key, and because React flushes a keystroke
  synchronously the second answer read a state the first had already
  cleared: closing a card left the mode as well. (`leglas`)
- **A reachable localhost port no longer silently passes as the intended app.**
  At startup, Leglas checks the working directory of a local port's listening
  process. If it sits outside the configured project, the CLI and interface
  name the likely mismatch and point to `devServer` or `--user-port` without
  blocking previews. Unsupported systems and unavailable process details stay
  on the existing best-effort path. (`leglas`)
- **A newly queued request starts immediately even as the previous run is
  finishing.** A request arriving during the final queue write of an active
  runner used to lose its immediate wake-up and wait for the two-second poll.
  Wake-ups are now latched until the active tick settles, without ever running
  two agents at once. (`leglas`)
- **Routine agent reads no longer wait behind stale authentication probes.**
  Leglas starts the initial CLI detection alongside server startup. Once it
  has a truthful result, ordinary reads return it immediately and refresh an
  expired answer in the background; opening the picker still waits for the
  explicitly requested fresh result. (`leglas`)
- **A preview's loading state belongs to the document that produced it.**
  Readiness was keyed by title alone, so a load event from a frame that had
  since been replaced, by an agent swapping the URL in place or a retry
  remounting the same one, could finish the loader early, leave it stuck or
  describe the wrong direction. It is now tracked by direction, URL and
  reload generation together, and events from an older frame are ignored.
  (`leglas`)
- **The duplicate check reads the page it was asked about.** A scan's verdict
  is recorded against the exact URL that produced it, so a direction whose
  URL changed under the same title is read again rather than trusted. Scans
  run one at a time, a read that failed is recorded as failed for this page
  load instead of retrying forever or passing as a signature, and the check
  waits on a direction with a request queued or running, since its source is
  about to change. (`leglas`)
- **Reading or choosing an agent cannot hang the picker.** Agent reads time
  out after five seconds and selections after ten. A selection that times
  out re-reads the server before reporting, so one accepted just before the
  deadline stays selected; otherwise the picker names the agent that was not
  selected and offers to try again. The chooser also stays available until
  an agent is chosen: the "I'll run my own" dismissal is gone, since
  `leglas watch` announces an external agent on its own. (`leglas`)

## 0.6.1 (2026-08-20): A broken first load comes back

### Fixed

- **A preview that broke on its first try comes back with the others.** When
  the dev server returns, Leglas reloads the previews that depend on it, but
  it only reloaded the ones that had rendered successfully at least once. A
  preview whose very first navigation failed had never rendered, so it was
  skipped: its error notice was cleared and the dead frame left in place, with
  nothing on screen to say it was still broken and no way back short of a
  manual reload. Every app-backed preview now reloads. (`leglas`)

## 0.6.0 (2026-08-20): The picker knows what is installed

### Changed

- **Agent choice now reflects what is actually installed.** Leglas checks the
  inherited `PATH` plus conventional per-user CLI locations, so a detached
  server finds the same Claude Code, Codex and Cursor commands as the user's
  terminal. Opening the picker requests a fresh detection instead of waiting
  for a stale cache to expire. Claude Code and Codex also gain an optional
  effort selector from Low through Maximum, remembered separately for each
  agent; `Agent default` passes no override and keeps the CLI's own setting.
  (`leglas`)

![The agent picker open above the composer: Claude, Codex with a tick, an Effort row set to Agent default, and Connect agent via MCP](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.6.0-picker-and-mcp/picker-with-effort.png#w=500 "The picker lists what is actually installed, with an effort row for Claude Code and Codex.")

- **MCP connection is now a complete, verifiable flow.** The agent picker has
  one clearly named `Connect agent via MCP` path instead of mixing a custom
  command editor with a nested copy panel. A focused dialog distinguishes
  Claude Code from Codex, Cursor, and other MCP clients, shows the exact setup,
  confirms a copy
  beside the control, explains the next step and reports once an MCP agent has
  used a Leglas tool. The same path stays visible when no local agent is
  installed. Custom commands remain available through `leglas watch --run`
  without occupying the primary picker. (`leglas`)

![The Connect agent via MCP dialog: a choice between Claude Code and Codex, Cursor and others, the terminal command with a copy button, and a row reading Waiting for agent activity](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.6.0-picker-and-mcp/connect-agent-via-mcp.png#w=570 "One dialog for the whole flow: pick the client, copy the exact setup, and watch it confirm once the agent uses a Leglas tool.")


### Fixed

- **The interface stays responsive with a rail full of directions.** Every
  live surface polls: the config for directions an agent registered, the
  queue for what a run is doing, health for whether the dev server still
  answers. Each one used to start a read on every tick whether or not the
  last had come back. A browser allows six connections per origin, and Leglas
  is a single origin shared with every preview iframe proxying the app, so a
  project with several directions open could spend that budget and leave the
  polls queueing behind each other. Nothing reported an error: the server
  answered in single-digit milliseconds while a click sat there for minutes.
  Each loop now keeps one read in flight at a time, and abandons one that
  outlives its deadline so the connection comes back. (`leglas`)

## 0.5.0 (2026-08-20): Point at what is wrong

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

![The interface in annotate mode: a dashed region covers the headline and the pouch with a numbered pin at its corner, the Annotate chip counts one note, and the composer offers to send with no words](https://raw.githubusercontent.com/FredAmartey/docs-assets/2ad249d23aba5f967d2f1ab4da2ea46ea978aa83/projects/leglas/pull-requests/0025-agent-run-legibility/annotate-region-kept.png "A region marked on the design. Pin 1 covers the headline and the pouch, and the note alone is a complete request.")

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
- **A new direction reaches the rail instead of stopping at the last step.**
  Claude runs non-interactively under Leglas, where it can accept file edits
  but has nobody to approve a command, so the `leglas add` that puts a new
  direction on the rail was refused every time. The run built the whole
  direction, explained that it could not register it, and exited cleanly;
  Leglas read that as success and dropped the request, so the card vanished
  and nothing appeared. The runner now permits exactly that one command, and
  a run that finishes without registering is recorded as a failure with its
  reason rather than disappearing as though it had worked. (`leglas`)
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

## 0.4.1 (2026-08-14): Deleting for good, dragging from anywhere

### Added

- **Removed directions can be deleted for good.** The removed list now has a
  per-direction Delete action and a Clear all action, both behind a
  confirmation. Machine-local directions leave `.leglas/previews.json` while
  shared config and preview source files stay untouched. (`leglas`)

### Fixed

- **A direction can be dragged from anywhere on its row.** Vertical movement
  reorders while horizontal movement still selects text, so the note no longer
  leaves most of the row unable to drag. (`leglas`)

![Before: a text selection painted across four rows of the rail, nothing moved](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0017-row-drag-rename/row-drag-before.png#w=372 "Before: pressing on a note and dragging painted a selection across four rows and moved nothing.")

![After: the dragged row lifted out of the list, the others making room](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0017-row-drag-rename/row-drag-after.png#w=372 "After: the row lifts and the others make room.")

- **Rename fields keep Enter and Space.** The row keyboard shortcut now runs
  only when the row itself has focus, so Enter submits a rename and spaces can
  be typed into its name. (`leglas`)
- **An unreadable local registry no longer hides working directions.** Leglas
  keeps the previews it booted with if `.leglas/previews.json` becomes invalid
  or unreadable. (`leglas`)
- **Delete confirmations keep keyboard focus contained.** Focus stays inside
  the dialog until it closes, then returns to the control that opened it.
  (`leglas`)

## 0.4.0 (2026-08-13): The interface runs your agent

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

![A run reporting in its card above the composer: Codex is on it, editing directions/hero-a.html, 1m 10s, a stop button](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0011-embedded-agent-runner/runner-running.png#w=600 "A run reporting in its card: who is working, the file they are touching, the clock and a stop button.")

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

![The picker open above the chip: Claude, Codex with a tick, and a row reading Add your own](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0011-embedded-agent-runner/runner-picker.png#w=560 "The picker above the chip: the CLIs found on the machine, and a row for a command of your own.")

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

![The connect sheet: Give your agent the Leglas tools, with a copy button beside Claude Code command and beside mcp.json for everything else](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0014-mcp-connect/connect-sheet.png#w=520 "The sheet behind Connect another agent: the Claude Code command or an mcp.json entry, one copy each.")


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

## 0.3.0 (2026-08-09): Installable as one thing

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

## 0.2.0 (2026-08-05): Ask for a change without leaving

Change requests, so you can ask for edits without leaving the comparison.

### Added

- **Ask for a change from the interface.** Type what you want changed on the
  direction you are looking at. Leglas writes a prompt naming that direction
  and the file behind it, copies it to your clipboard, and queues it, with a
  lifecycle the interface can show.

![The input bar under the rail with a notice above it: Asked for a change to Aurora. Prompt copied. The hint reads 1 change queued for your agent](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0002-change-request-lifecycle/request-queued.png#w=560 "A change asked for from the input bar: the prompt is on the clipboard and the hint says one change is queued.")

- **`leglas watch --run "<command>"`** hands each request to your agent as it
  arrives, so you can keep working while it acts on them.

![The Leglas interface with Aurora selected, its gradient now warm orange fading to blue, and the hint under the input bar reading Your agent is listening](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0003-agent-watch/aurora-after.png "Aurora after the watcher handed a change to the agent. The hint under the input bar reads Your agent is listening.")

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

## 0.1.0 and 0.1.1 (2026-08-01): First release

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

![The first Leglas interface: a rail headed Directions with five of them and Table selected, and the Simmer hero running full width on the stage](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.1.0-first-release/rail-and-stage.jpg "Leglas 0.1.0, built from its tag and pointed at a demo app: the rail on the left, and the selected direction running as the real app on the stage.")

