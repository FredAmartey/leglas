# Changelog

Leglas ships as three things, released together under one version number:

- **`leglas`**, the command line tool, on npm
- **`leglas-mcp`**, the MCP server for agent hosts without a shell, on npm
- **the Agent Plugin**, which is this repository's own directory

Each entry ends with which of the three it reaches.

## Unreleased

### Fixed

- **The MCP tools refuse what the command line refuses.** `add` saved an empty
  note and answered a missing URL with `previews[0] needs a url.`, and `show`
  with a width but no screenshot, or `share` stopping with a direction named,
  ignored the extra input. Each tool now checks the command line's rules first
  and answers in its words, like `--note needs a value.` `explore` also takes
  any count the command line takes; it stopped at 24. (`leglas-mcp`)

- **`leglas --help` lists `init --force` and `requests --clear`.** Both worked,
  but the help never mentioned them. (`leglas`)

## 1.3.0 (2026-09-25): Build a set of directions from a brief

### Added

- **Build a set of directions from a brief, with Claude or Codex.** Turn on
  **Build directions with Claude or Codex** under Labs in the tools, press
  **+** at the top of the rail, say what to explore, pick how many (up to six)
  and press **Build 3 with Claude**, named for your agent. The agent plans the
  set first, so the directions differ from each other and from what's already
  on the rail, then builds them side by side. Each row shows whether its
  direction is building, being checked, failed or stopped, and you can stop
  it, retry it or ask for a new idea. One that doesn't render gets one attempt
  to fix itself. Runs use your own plan at medium effort, without your MCP
  servers, skills or plugins. On the demo app Claude built three in about a
  minute and a half, Codex in a little over two. From a terminal:
  `leglas explore hero --build --brief "…"`. (`leglas`)

- **See a set side by side, and ask for more like one.** Once two directions
  of a set are ready, **Compare all** on the set's card puts the ready ones on
  the stage side by side, each at its own width. With a direction on the
  stage, **More like Menu** in the brief (named for that direction) builds
  variations that keep it and each change one thing, and puts them under it.
  What to vary is optional. From a terminal, add `--based-on "Menu"` to
  `explore --build`. (`leglas`)

- **`leglas watch --json` prints a JSON line per event.** The instructions
  `leglas init` writes, the plugin's skill and the docs all said every command
  takes `--json`, but `watch` refused it. It now prints a line when it starts,
  hands a change to the agent, finishes or fails one, can't read the queue,
  and stops. With `--json` the agent's own output goes to stderr; without it,
  nothing changes. (`leglas`, plugin)

### Fixed

- **Update notices reach the interface right away.** Since 1.1.0 the interface
  ignored the server's update messages and only caught up on its next check:
  up to 15 seconds late with the panel open, 15 minutes with it closed.
  (`leglas`)

- **A failed update shows npm's message.** It showed one of npm's fields
  instead, like `syscall mkdir`. Now it shows the message itself, such as
  `Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/leglas'`.
  (`leglas`)

- **`keep --to` accepts a full path.** An absolute path was nested inside the
  project: `--to /home/me/app/src/hero.tsx` wrote
  `app/home/me/app/src/hero.tsx`. It now lands where its relative form would,
  and a path outside the project is refused. (`leglas`, `leglas-mcp`)

- **The placeholder `leglas new` writes no longer breaks your page.** Without
  `--from`, the example code in its note was read as JSX, and the page threw
  `Hero is not defined` until you replaced the placeholder. Broken since
  0.1.0. (`leglas`, `leglas-mcp`)

- **The agents guide gets `LEGLAS_PROJECT_DIR` right.** It said the host's
  workspace wins over the variable. The variable wins when it's set.
  (`leglas-mcp`)

## 1.2.1 (2026-09-24): Screenshots wait for late fonts, pictures and code

### Changed

- **The architecture page opens with a map.** The docs' architecture page
  starts with a diagram of Leglas's ten parts and the path a change takes
  through them, a plain-language version under it and a button that copies a
  setup prompt for your agent. The README's front page was reworked too.
  (`leglas`)

### Fixed

- **Screenshots wait for fonts, images and code that load late.** A React app
  in Vite asks for most of them after the page's load event, which is when
  Leglas took the shot, so a capture could show fallback fonts, missing images
  or a blank page. Leglas now waits until nothing the page asked for is still
  loading: at most two seconds more, about 30 ms on a plain page.
  (`leglas`, `leglas-mcp`)

- **Adding a direction no longer reloads the page.** The switch file
  `leglas new` writes exported a helper beside the component, which stops hot
  reload swapping the file in, so every direction an agent added reloaded the
  page you were looking at. A switch file written before this release keeps
  the old shape; one written from now on doesn't. (`leglas`)

## 1.2.0 (2026-09-22): Share from a terminal, and an agent that goes quiet says so

### Added

- **Share from a terminal or an agent.** `npx leglas share` shares the whole
  rail, `npx leglas share "Aurora"` one direction, and two names put them side
  by side. It prints the link once the tunnel is up and when it stops working,
  and `--stop` ends it. The MCP server has a `share` tool that does the same.
  A share started this way uses the project's rail: every direction in config
  order, under the names you gave them. (`leglas`, `leglas-mcp`)

### Changed

- **A quiet agent says so, and can't hold up the queue.** An agent stuck on
  something nothing in Leglas can answer, like a trust prompt, used to block
  every change behind it for as long as it sat there. After 3 minutes of
  silence the card says how long it's been quiet. After 30 minutes, Leglas
  ends the run with a reason and starts the next change. Any output resets
  both, so a long build isn't cut off. (`leglas`)

### Fixed

- **A site that refuses to be framed says so.** A direction pointing at a site
  that forbids framing showed the browser's broken page. The pane now names
  the site and the header that refused it, offers to open it in a tab, and if
  the site is yours, says which header to change. Leglas checks without your
  cookies, so if a signed-in page does frame, **Show the frame anyway** shows
  it for the rest of the session. (`leglas`)

- **Every command answers `--help`.** `init`, `explore`, `list`, `log`,
  `show`, `requests` and `keep` refused it, and `leglas log -h` looked for an
  entry called "-h". (`leglas`)

- **Stopping an agent stops what it started.** A stop, or the 30 minute
  silence limit, only reached the agent itself, so a dev server or watcher it
  had launched kept running. Agents Leglas starts now run in their own process
  group, and a stop reaches all of it. The MCP server also shuts down when its
  host's terminal closes. Claude and Codex runs in a warm session still stop
  with the vendor's own interrupt. (`leglas`, `leglas-mcp`)

## 1.1.2 (2026-09-18): The card on a row is drawn again

### Fixed

- **A direction's card shows when you hover its row.** Since 0.9.0 the card
  that says where a direction came from opened but was never drawn: the rail's
  faded edges clipped it. Tips now draw over the whole interface. (`leglas`)

- **A screen reader announces the attach button once.** The hidden file input
  behind it was announced as a second, unnamed control. (`leglas`)

## 1.1.1 (2026-09-17): The links on the npm page work

### Fixed

- **The links on the npm page work.** npm resolves the README's relative links
  against `packages/cli`, so the Contributing and License links pointed at
  nothing, and the new docs links would have too. They're absolute now.
  (`leglas`, `leglas-mcp`)

## 1.1.0 (2026-09-07): Leglas says when a newer version is out

### Added

- **Leglas tells you when a newer version is out, and updates from the
  interface.** The version sits beside the wordmark. Once a day at startup
  Leglas asks npm for a newer one; if there is, the terminal says so and the
  version gets a dot. Open it and press **Update**: Leglas installs the new
  version the way this one was installed (npm, pnpm, yarn or bun, global or in
  the project, or just a restart if you run it through npx, pnpm dlx, bunx or
  yarn dlx), starts again on the same port and reloads the page. **Skip**
  hides that version until the next. You can also check by hand from the
  panel. The startup check is off under `CI` or with
  `LEGLAS_NO_UPDATE_CHECK=1`. Releases are on GitHub now too, so you can watch
  the repository for them. (`leglas`)

![The version chip's panel: 1.1.0 is out, the release title, You have 1.0.0, an Update button and Skip, and the command Update will run](https://raw.githubusercontent.com/FredAmartey/docs-assets/c5e1dbd0debd30a5df3f517c0db76c6a843eb8dd/projects/leglas/pull-requests/0067-updates/panel-available.png#w=440 "What a 1.0.0 sees once this release is on npm: the panel behind the version, with Update and what it will run.")

### Fixed

- **Cursor runs start.** In a project Cursor hadn't been trusted for by hand,
  a run stopped at Cursor's workspace-trust prompt and ended in a second with
  nothing on the card. Leglas now trusts the project for the run. Cursor's
  edits are recognised too, so the card shows the file it's changing and a run
  whose session ended is retried once, as with Claude and Codex. (`leglas`)

## 1.0.0 (2026-09-06): Share the rail with someone who has no repo

### Added

- **Share what is on your rail with someone who has no repo.** The share
  control in the rail's header shares the whole rail as you see it, or what's
  on the stage. Leglas opens a second listener, points a tunnel at it
  (cloudflared or ngrok, whichever is installed; no account needed) and copies
  the link once it answers. Viewers get your real app in your order and names,
  and can flip, compare, search and change the width, but can't change
  anything: everything through the share is read-only, and without the link's
  cookie every path answers 403. The panel shows whether the tunnel is up and
  how many people are looking, offers to update the share when your rail has
  changed and stops it. The share also stops with Leglas. Dev server routes
  that act on your machine, like Vite's open-in-editor, are refused, and so is
  registering a service worker. Branch directions aren't shared yet, and the
  panel says so. (`leglas`)
- **Several links, each turned off on its own.** A share holds up to sixteen
  named links. The panel lists each with its time left and its sessions.
  Turning one off ends it at once, even mid-page, and tells whoever was on it.
  A link lasts a day, and one click gives it another. An expired link can't be
  brought back, because every copy of it would come back too, so make a new
  one. **Replace all** ends every link and gives the share a new address. A
  link belongs to a browser, not a person: a second link opened in the same
  browser replaces the first. (`leglas`)
- **Choose how much of your app a viewer can reach.** "Anywhere in the app" is
  how sharing worked before: a link reaches any route your dev server has,
  your source included. "Only what you shared" serves the shared pages and the
  files they load, which Leglas learns from what your directions loaded while
  you looked at them, and refuses everything else. If a page later needs
  something it refused, like a chunk that loads on scroll, the panel shows it
  and one click allows that file or its folder. Files starting with a dot,
  like `.env` and `.git`, are never served to a viewer. (`leglas`)
- **A busy share can't slow you down.** Viewers get at most twelve requests in
  your dev server at once. The rest wait in Leglas, shared fairly between
  links, and are turned away if they wait too long. With 200 requests at once,
  your own reload went from 136 ms to 21 ms. (`leglas`)

## 0.9.0 (2026-09-03): The rail shows where each direction came from

### Changed

- **The rail shows where each direction came from.** Variants were flattened
  under their family's first direction, so eight rows read as eight siblings.
  Each variant now follows the direction it was made from, and a gutter draws
  the family like `git log --graph`: a lane per branch, a fork where a sibling
  leaves, a ring on the row on stage. The line back to the root is lit, and
  hovering a row aims it there. The crumbs under the composer name the same
  ancestry; click one to go there, shift-click to compare. Dragging a row
  moves it among its siblings, and a family moves with its root. With reduced
  motion on, nothing animates. (`leglas`)

![The rail with Counter's family open: Olive Night on stage, its line lit back to Counter, then the family folded away and opened again](https://raw.githubusercontent.com/FredAmartey/docs-assets/b7ebfaa5bf87e2c749757e850ba9fb0eb13116b0/projects/leglas/changelog/0.9.0-rail-lineage/rail-lineage.gif#w=368 "Olive Night traced back to Counter, the line aimed at whichever row the pointer rests on, then the family folded away and back.")

### Fixed

- **A branch preview that hadn't started no longer blanks the interface.** The
  duplicate check read its URL before it had one and took the page down on
  load. (`leglas`)

- **A variant of a captured page no longer shows pieces of its parent.** On a
  page that rebuilds itself in the browser (a captured production site, a
  static export, any hydrating app served as a file), a variant could show the
  parent's hero, logo and buttons, because the framework rebuilt it from the
  parent's JavaScript. The capture now always keeps the console line that
  shows it, the request tells the agent to make the change where the
  JavaScript gets its content, and `leglas show` reports it. Directions
  switched in components weren't affected. (`leglas`, `leglas-mcp`, plugin)

## 0.8.0 (2026-08-28): An exploration writes down what it decided

For code that imports `leglas`: `ParseResult` gained a `log` kind.

### Added

- **An exploration writes down what it decided.** `leglas keep` now writes an
  entry to `design-log/` before clearing the exploration: markdown and PNGs
  you commit, with every direction, its note, its capture, the words asked of
  it and which one won. Nothing is invented, and a change that failed is
  listed once at the end with why. `leglas log` lists entries and prints one,
  and the instructions Leglas writes for agents tell them to read it before
  exploring, so a rejected direction isn't proposed again. `logDir` changes
  the folder. (`leglas`)

![A design-log entry as GitHub renders it: hero, 2026-08-28; Table won and became src/hero.tsx, 8 directions were compared; then the Table section with its capture and the words that were asked for it](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.8.0-design-log/design-log-entry.jpg "What leglas keep writes before it clears the exploration: the winner, every direction with its note and its capture, and the words typed at each of them.")

### Changed

- **An idle branch stops.** A branch preview opened once kept its checkout and
  dev server until the session ended. After ten minutes without traffic it's
  stopped and its checkout removed, and opening it starts it again. A branch
  still serving, like one holding a live-reload connection, or one still
  starting, is left alone. (`leglas`)
- **The interface stops downloading unchanged answers.** `/api/config`,
  `/api/requests`, `/api/annotations` and `/api/health` send an ETag and
  answer 304 when nothing changed. (`leglas`)

### Fixed

- **Branch previews served only 502.** The proxy looked up an IPv6 address
  like `[::1]` with its brackets, which fails, so any branch bound to IPv6
  (Vite's default on macOS) was unreachable. (`leglas`)

## 0.7.4 (2026-08-27): Branches start when you open them

### Changed

- **A branch preview starts when you open it.** Every branch used to be
  checked out, installed and served before the interface appeared, opened or
  not: 8.3 seconds and 272 MB for two branches on a small project. Now the
  interface is up in 1.6 seconds and only the branch you open costs anything.
  The pane shows which step it's on, a failure says why and offers a retry,
  and the rail shows a branch preview's branch instead of a random loopback
  URL. (`leglas`)

![The pane of a branch preview while it starts: a spinner, the line Installing what it needs, and under it A branch runs in its own checkout, built the first time you open it this session](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.7.4-branch-starts-when-opened/installing-what-it-needs.png#w=500 "Opening a branch is what starts it, and the pane says which step it is on: checking out, installing, starting its dev server.")

## 0.7.3 (2026-08-27): Branch previews on a default Vite project

### Fixed

- **Branch previews start on a default Vite project.** Leglas waited for a
  branch's dev server on `127.0.0.1` only, but Vite's default on current macOS
  and Node listens on `::1`, so every branch timed out after 90 seconds and
  its checkout was deleted. The wait now tries both addresses. A project's own
  `devCommand` had the same problem and is fixed too. (`leglas`)

## 0.7.2 (2026-08-27): The interface stops polling

### Changed

- **The interface stops polling.** It polled the config, the queue and health
  every 2 to 3 seconds: 100 requests and 108 KB a minute from an idle tab. The
  server now sends a notice over a websocket at `/leglas/api/live` when
  something changes, and the interface reads it then. An idle tab makes 16
  requests (8 KB) a minute, and a direction an agent registers reaches the
  rail in about 223 ms instead of up to 3 seconds. If the socket drops, each
  read falls back to every 15 seconds. (`leglas`)

## 0.7.1 (2026-08-27): A malformed body can't stop the server

### Fixed

- **A malformed request body can't stop the server.** 0.7.0 made every route
  that reads a body refuse anything but a JSON object, but
  `POST /api/capture`, added in the same release, skipped that check: `null`
  sent to it from this machine ended the server and the run under way. It uses
  the check now, and so does `/api/annotations/update`, which already checked
  inline. (`leglas`)
- **A route added later can't miss that check**: the test reads the routes out
  of the server rather than from a list. (`leglas`)

## 0.7.0 (2026-08-27): The agent sees what you see

For code that imports `leglas`: its exports changed, and it gained an optional
dependency on the Claude Agent SDK.

### Added

- **Every change request carries what you see.** Sending a change renders the
  direction in a headless browser found on your machine (Chrome, Chromium,
  Brave, Edge, Arc, or a Playwright or Puppeteer cache; `LEGLAS_BROWSER`
  overrides) at its design width, and saves it under
  `.leglas/captures/<request>/` with a crop of each note, the compared
  direction when the stage is split, and any reference images. The prompt
  names each file and console errors from the load come along as text.
  Claude's warm session and Codex get the images directly; everything else,
  the `claude -p` fallback included, gets the paths. With no browser, the
  request still goes and says why nothing was captured. Captures are removed
  with their request. (`leglas`)

![The composer a moment after sending: the field is disabled, a reference thumbnail sits above it, and the hint reads Capturing the design for your agent](https://raw.githubusercontent.com/FredAmartey/docs-assets/377e0b3810067971eee37f8f940c9bf690b256fa/projects/leglas/pull-requests/0032-agent-eyes/composer-capturing.png#w=480 "Send, and the direction is captured for the agent first; a reference image attached to the composer rides along.")

- **Reference images in the composer.** Paste, drop or attach up to four PNG,
  JPEG, WebP or GIF images of 10 MB or less. (`leglas`)
- **`leglas show <title> --screenshot`** renders a direction and prints the
  PNG's path. `--width` sets the viewport (320 to 3840) and `--port` picks
  another running Leglas. The MCP `show` tool takes `screenshot: true` and
  returns the image. The instructions for agents now ask them to look at each
  direction once before calling it done. (`leglas`, `leglas-mcp`, plugin)

![A rendered direction: a dark landing page whose headline reads Catch it while it's still humming, over orange sound waves](https://raw.githubusercontent.com/FredAmartey/docs-assets/377e0b3810067971eee37f8f940c9bf690b256fa/projects/leglas/pull-requests/0032-agent-eyes/what-the-agent-received-frame.png "What one request handed the agent: the direction at the width it was drawn at, filed under .leglas/captures/.")

- **`.leglas/server.json`** records the running server's port so other
  commands can find it, and `/leglas/api/health` names the project it serves,
  so a command pointed at the wrong Leglas is told so. (`leglas`)

- **A row shows when an agent is working on it.** The badge appears while an
  agent has the request, not while it's only queued. (`leglas`)
- **An annotation opens again.** Click a pin to reopen its card and reword or
  drop the note. Enter saves, Escape closes and **Forget it** removes it.
  Nothing you need to reach hides behind a hover any more, and pins work from
  the keyboard. (`leglas`)
- **A pin shows when its words are already with an agent.** A note in a sent
  change gets a ring until the change settles. Rewording it then applies to
  the next change, not the one in flight. (`leglas`)

### Changed

- The Claude Code permission a request carries covers `leglas show` as well as
  `leglas add`. (`leglas`)

- **Claude runs use one warm session.** Leglas starts Claude when the composer
  takes focus or you pick an agent, keeps it across requests and stops a run
  with the SDK's interrupt. Your model, settings, tools and permissions still
  apply. Nothing starts with Leglas, only one agent is kept warm, and five
  idle minutes let it go; it comes back with the conversation intact. If the
  optional SDK can't load, Leglas falls back to `claude -p`. (`leglas`)
- **Codex runs stay warm the same way**, through one Codex app-server, and
  fall back to `codex exec` on older Codex builds. (`leglas`)
- **Cursor continues its chat between requests.** Leglas resumes the session
  each run reports, so the project is read once rather than every time.
  (`leglas`)

### Fixed

- **The screenshot browser closes with Leglas.** Closing the terminal left the
  headless browser running, unseen, until you restarted the machine. It closes
  now, and a Leglas that crashed has its browser closed by the next one, which
  leaves another running Leglas's browser and other users' alone. (`leglas`)
- **Flipping between directions loads each one once.** The duplicate check
  read the direction you'd just opened a second time in a hidden frame. Ten
  flips on a Next dev server went from 25 page compiles to 9, and the check
  pauses while the tab is in the background. (`leglas`)
- **The dev server drops requests the browser gave up on.** When a preview
  goes away, the proxy ends its request instead of letting it finish.
  (`leglas`)
- **The interface no longer re-renders every three seconds.** The health poll
  replaced unchanged state on every tick. (`leglas`)
- **Cursor runs show what they're doing.** Leglas read Cursor's output as
  Claude's, so the card never showed a file and Leglas couldn't tell it had
  edited anything. (`leglas`)
- **`leglas watch` hears a stop during startup.** A stop sent while it was
  starting was ignored and the loop kept running. (`leglas`)
- **A malformed request body can't stop the server.** Every route that reads a
  body refuses anything but a JSON object. Sending `null` to loopback used to
  end the process. (`leglas`)

- **One Escape backs out one step while annotating.** Closing a card also left
  annotate mode. (`leglas`)
- **Leglas warns when your dev server's port looks like another project.** At
  startup it checks where the process on that port runs, and if that's outside
  the project, the terminal and interface say so and point to `devServer` or
  `--user-port`. It's best effort, skipped where the process can't be read,
  and never blocks previews. (`leglas`)
- **A request sent as a run finishes starts right away**, instead of waiting
  for the next two-second poll. (`leglas`)
- **Reading the agent list doesn't wait on a slow login check.** Leglas checks
  installed agents at startup and answers with the last result while
  refreshing it. Opening the picker still asks for a fresh one. (`leglas`)
- **A preview's loading state follows the right page.** A load event from a
  replaced frame could end the loader early, leave it stuck or name the wrong
  direction. (`leglas`)
- **The duplicate check reads the page it was asked about.** A direction whose
  URL changed is read again, a failed read counts as failed instead of
  retrying forever, and a direction with a change queued or running waits
  until it's done. (`leglas`)
- **The agent picker can't hang.** Reading agents times out after five seconds
  and choosing one after ten. A choice that timed out is checked before it's
  reported as failed. The "I'll run my own" option is gone, since
  `leglas watch` announces itself. (`leglas`)

## 0.6.1 (2026-08-20): A broken first load comes back

### Fixed

- **A preview that failed on its first load comes back with the others.** When
  the dev server returned, Leglas reloaded only previews that had loaded once,
  so one that failed the first time stayed dead with no error showing. Every
  app preview reloads now. (`leglas`)

## 0.6.0 (2026-08-20): The picker knows what is installed

### Changed

- **The agent picker shows what's installed.** Leglas looks on your `PATH` and
  in the usual per-user install folders, so it finds the same Claude Code,
  Codex and Cursor your terminal does, and opening the picker checks again.
  Claude Code and Codex also get an effort setting from Low to Maximum,
  remembered per agent; **Agent default** keeps the CLI's own. (`leglas`)

![The agent picker open above the composer: Claude, Codex with a tick, an Effort row set to Agent default, and Connect agent via MCP](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.6.0-picker-and-mcp/picker-with-effort.png#w=500 "The picker lists what is actually installed, with an effort row for Claude Code and Codex.")

- **Connecting an agent over MCP is one flow.** "Connect agent via MCP" in the
  picker opens a dialog for Claude Code, or for Codex, Cursor and other MCP
  clients, shows the exact setup to copy and confirms once the agent uses a
  Leglas tool. Custom commands moved to `leglas watch --run`. (`leglas`)

![The Connect agent via MCP dialog: a choice between Claude Code and Codex, Cursor and others, the terminal command with a copy button, and a row reading Waiting for agent activity](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.6.0-picker-and-mcp/connect-agent-via-mcp.png#w=570 "One dialog for the whole flow: pick the client, copy the exact setup, and watch it confirm once the agent uses a Leglas tool.")

### Fixed

- **The interface stays responsive with many directions.** Its polls started a
  new read every tick even if the last hadn't returned, and could use up the
  browser's six connections to Leglas, leaving clicks waiting for minutes.
  Each poll now keeps one read in flight and gives up on it after a deadline.
  (`leglas`)

## 0.5.0 (2026-08-20): Point at what is wrong

For code that imports `leglas`: `PendingRequest.status` gained two values, and
the type gained `failure`, `mode` and `notes`.

### Added

- **Point at what's wrong instead of describing it.** Press `A`, or the
  Annotate chip beside send: hovering outlines elements, clicking drops a
  numbered pin with a note and dragging marks an area. The page still scrolls.
  Annotations are a complete request, so the text field can stay empty. Each
  note carries the element's text, tag, classes, CSS path and position, and
  says so if the element has gone. Notes live in `.leglas/annotations.json`,
  and a change made in place forgets the ones it answered. (`leglas`)

![The interface in annotate mode: a dashed region covers the headline and the pouch with a numbered pin at its corner, the Annotate chip counts one note, and the composer offers to send with no words](https://raw.githubusercontent.com/FredAmartey/docs-assets/2ad249d23aba5f967d2f1ab4da2ea46ea978aa83/projects/leglas/pull-requests/0025-agent-run-legibility/annotate-region-kept.png "A region marked on the design. Pin 1 covers the headline and the pouch, and the note alone is a complete request.")

- **A change makes a variant instead of overwriting.** A change now builds a
  new direction from a copy of the one you're looking at, nested under it with
  the original as its comparison. A chip beside send switches to editing the
  direction itself, for when a change really is a fix. (`leglas`)
- **A direction says where it came from.** Hovering a row shows its full note,
  the direction it was built from and the change that was asked for. The
  selected direction shows the same under the composer. Agents register it
  with `leglas add --asked-for`, also on the MCP `add` tool.
  (`leglas`, `leglas-mcp`)

### Fixed

- **Codex changes finish faster.** Codex can now reach the live preview from
  its sandbox, the request tells it setup is already done, and registration
  calls the running Leglas directly instead of `npx`, which cuts the extra
  checks that could stretch a small edit to minutes. Your model and effort are
  unchanged. (`leglas`)

- **Codex works outside a git repository.** `codex exec` refuses such folders,
  so every Codex request there failed without saying why. Leglas passes
  `--skip-git-repo-check`; writes stay confined by `-s workspace-write`.
  (`leglas`)
- **A stopped run is recorded as stopped**, not as a failure offered for a
  rerun, and it stays that way across a restart. (`leglas`)
- **A failed change says why**: you stopped it, the provider is overloaded,
  the CLI is signed out or missing, or Codex refused the folder. The agent's
  own output stays in the terminal. (`leglas`)
- **A new direction reaches the rail.** Claude couldn't run the `leglas add`
  that registers it, since nobody was there to approve the command, and Leglas
  took the clean exit as success. Leglas now allows exactly that command, and
  a run that ends without registering is a failure with a reason. (`leglas`)
- **A run waiting on an overloaded provider says so**: "provider is overloaded
  · retry 4 of 10" instead of a spinner. The vendor's retries are left alone.
  (`leglas`)
- **A stopped agent can't jam the queue.** An agent that ignored the stop kept
  its run going forever; a stop now escalates after five seconds. The same fix
  unsticks the agent login check. (`leglas`)
- **A failed request doesn't cost two provider turns.** A dead resumed session
  is retried cold only when nothing else explains the failure, not during an
  outage. (`leglas`)
- **The same change can't be queued twice by accident.** Identical words at
  the same direction are refused while one is waiting. (`leglas`)

## 0.4.1 (2026-08-14): Deleting for good, dragging from anywhere

### Added

- **Removed directions can be deleted for good**, one at a time or all at
  once, after a confirmation. Local directions leave `.leglas/previews.json`;
  shared config and source files stay. (`leglas`)

### Fixed

- **Drag a direction from anywhere on its row.** Moving up or down reorders;
  moving sideways still selects text. (`leglas`)

![Before: a text selection painted across four rows of the rail, nothing moved](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0017-row-drag-rename/row-drag-before.png#w=372 "Before: pressing on a note and dragging painted a selection across four rows and moved nothing.")

![After: the dragged row lifted out of the list, the others making room](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0017-row-drag-rename/row-drag-after.png#w=372 "After: the row lifts and the others make room.")

- **Rename fields keep Enter and Space.** The row's shortcuts only run when
  the row itself has focus. (`leglas`)
- **A broken local registry no longer hides directions.** If
  `.leglas/previews.json` becomes unreadable, Leglas keeps the previews it
  started with. (`leglas`)
- **Delete confirmations keep keyboard focus inside**, then return it to the
  control that opened them. (`leglas`)

## 0.4.0 (2026-08-13): The interface runs your agent

### Added

- **The interface runs your agent.** Pick Claude Code, Codex, Cursor or a
  command of your own beside the send button, and Leglas runs it for each
  request, one at a time in order. A card above the field shows who's working,
  on which file and for how long, with stop, retry and dismiss. It's your
  agent and your subscription: no keys, no login. (`leglas`)

![A run reporting in its card above the composer: Codex is on it, editing directions/hero-a.html, 1m 10s, a stop button](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0011-embedded-agent-runner/runner-running.png#w=600 "A run reporting in its card: who is working, the file they are touching, the clock and a stop button.")

- **The picker knows who's signed in.** Leglas asks each CLI
  (`claude auth status`, `codex login status`), so a signed-out agent is
  marked before a run fails. (`leglas`)
- **Any command can be the agent.** "Add your own" takes a command like aider
  or goose. Your request goes in as its last argument, or wherever `{prompt}`
  sits. The same works in `leglas watch --run`. (`leglas`)

![The picker open above the chip: Claude, Codex with a tick, and a row reading Add your own](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0011-embedded-agent-runner/runner-picker.png#w=560 "The picker above the chip: the CLIs found on the machine, and a row for a command of your own.")

- **`leglas watch` doesn't need `--run` once an agent is picked.** The choice
  is shared through `.leglas/watch.json`, and an external watcher always wins
  over the built-in runner. (`leglas`)
- **Requests share the agent's session.** After the first request, runs resume
  the same conversation (`codex exec resume`, `claude --resume`), measured 25
  to 40 percent faster. A session ends on a failure, a stop or after eight
  turns, and starts fresh if the vendor has forgotten it. (`leglas`)
- **Connect agents Leglas can't run.** "Connect another agent" gives the MCP
  setup for IDE panels and chat hosts. An agent working the queue over MCP
  counts as attached, so the built-in runner stays out of its way until it
  goes quiet. (`leglas`, `leglas-mcp`)

![The connect sheet: Give your agent the Leglas tools, with a copy button beside Claude Code command and beside mcp.json for everything else](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0014-mcp-connect/connect-sheet.png#w=520 "The sheet behind Connect another agent: the Claude Code command or an mcp.json entry, one copy each.")

### Changed

- **Runs start when you send and finish in half the time.** Requests no longer
  wait for a poll, and the prompt tells the agent how small the job is, so it
  doesn't run tests on a design tweak. A typical small change went from about
  a minute to under thirty seconds. (`leglas`)
- Changes through `/leglas/api/` are only accepted from your own machine:
  every POST needs a loopback connection, and a browser's Origin has to match
  its Host. Shared links still open and view directions. (`leglas`)

## 0.3.0 (2026-08-09): Installable as one thing

### Added

- **An installable agent skill.** `npx skills add FredAmartey/leglas` teaches
  an agent the workflow in any project, setup included.
- **The repository is an [Agent Plugin](https://agent-plugins.org).**
  `plugin.json` and `mcp.json` sit at the root and the skill in
  `skills/leglas/`, so a client that supports the standard gets the skill and
  the server together.
- **An Install section in the README**, saying there's nothing you have to
  install.
- **The published API is recorded.** `api-surface.txt` lists what both npm
  packages export, a test compares it with the build, and a patch release is
  refused if it moved.
- **A weekly check on the vendored Agent Plugins schemas** opens an issue when
  they change.
- **The plugin manifests are checked against the standard's schemas**, so a
  typo fails the tests instead of a client quietly skipping a component.

### Fixed

- **The MCP server no longer sets up the wrong folder.** A plugin client
  starts the server inside the plugin's install folder, so `init` wrote
  `AGENTS.md` into a plugin cache. The server now takes the project from the
  workspace the host declares, uses the working directory only when it's
  inside one, and `LEGLAS_PROJECT_DIR` overrides both. With none of them, the
  tools say there's no project. Through `claude mcp add` or a hand-written
  `.mcp.json`, nothing changes.
- **Change requests the agent never collected aren't cleared**, so `--clear`
  only drops what was handed over.
- **Config edits that need a restart say so**, and unknown `/leglas` paths
  return 404.

### Changed

- Suggested commands read `npx leglas ...`, since nothing has to be installed
  first.

### Changed, and only if you import the packages

- `registerLeglasTools` and `startChannel` from `leglas-mcp` take
  `{ project }` instead of `{ cwd }`. Running `npx leglas` and calling the MCP
  tools are unchanged.

## 0.2.0 (2026-08-05): Ask for a change without leaving

### Added

- **Ask for a change from the interface.** Type what you want changed on the
  direction you're looking at. Leglas writes a prompt naming that direction
  and its file, copies it to your clipboard and queues it, and the interface
  shows where it's got to.

![The input bar under the rail with a notice above it: Asked for a change to Aurora. Prompt copied. The hint reads 1 change queued for your agent](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0002-change-request-lifecycle/request-queued.png#w=560 "A change asked for from the input bar: the prompt is on the clipboard and the hint says one change is queued.")

- **`leglas watch --run "<command>"`** hands each request to your agent as it
  arrives, so you can keep working.

![The Leglas interface with Aurora selected, its gradient now warm orange fading to blue, and the hint under the input bar reading Your agent is listening](https://raw.githubusercontent.com/FredAmartey/docs-assets/d6ae73e3ac9ce4e1411156da21c4596a3503c5da/projects/leglas/pull-requests/0003-agent-watch/aurora-after.png "Aurora after the watcher handed a change to the agent. The hint under the input bar reads Your agent is listening.")

- **Channel push.** On hosts that support channels, the MCP server delivers
  each request straight into the open session instead of waiting to be asked.
- **`leglas show <title>`** prints everything about one direction: its entry,
  its file, its variants, what it's compared against and anything pending on
  it.
- **Directions appear in the rail as an agent registers them**, so you watch a
  set fill in.
- **Variants group under the direction they're based on.**
- A logo across the README, favicon and interface. A keymap on `?` and
  reworked keyboard shortcuts. Loading states, tag colours drawn from the
  text, and two distinct ways to copy a direction.

### Fixed

- The duplicate check sees colour, and scans directions you haven't opened
  yet.
- Tooltips stay inside the viewport, and refit when their label changes while
  open.
- Dragging and tapping the tools widget.
- Copy, rename and remove say whether they worked.

### Changed

- The agent picks the design angles; Leglas prescribes none.
- Releases are published from CI through npm trusted publishing, and carry
  build provenance from 0.2.0 on.

## 0.1.0 and 0.1.1 (2026-08-01): First release

The first release, and a documentation fix the same day. Both were published
by hand, so they carry no provenance, and the `v0.1.0` tag doesn't match them
exactly.

Point Leglas at the dev server you already run, list the URLs you want to
compare, and flip between them in one interface. Every preview is your real
app: real data, real auth, real behaviour.

- The rail, the stage, split comparison and a saved layout per project.
- `leglas init` writes an `AGENTS.md` section that teaches agents the
  workflow.
- `leglas new`, `explore`, `classify`, `add`, `list` and `keep`.
- `leglas-mcp` for agent hosts that can't run a shell.
- Branch previews, plain HTML directions with no dev server, and a duplicate
  check for two directions that render the same page.

![The first Leglas interface: a rail headed Directions with five of them and Table selected, and the Simmer hero running full width on the stage](https://raw.githubusercontent.com/FredAmartey/docs-assets/e78751b8258d1c33f29946465b54080b20d9321c/projects/leglas/changelog/0.1.0-first-release/rail-and-stage.jpg "Leglas 0.1.0, built from its tag and pointed at a demo app: the rail on the left, and the selected direction running as the real app on the stage.")
