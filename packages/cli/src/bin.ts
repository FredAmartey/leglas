#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./args.js";
import { runClassify } from "./run-classify.js";
import { runExplore } from "./run-explore.js";
import { runExploreBuild } from "./run-explore-build.js";
import { runInit } from "./run-init.js";
import { runKeep } from "./run-keep.js";
import { runNew } from "./run-new.js";
import { runLog } from "./run-log.js";
import { runAdd, runList, runRequests } from "./run-previews.js";
import { runShare } from "./run-share.js";
import { runShow } from "./run-show.js";
import { runWatch } from "./run-watch.js";
import { startViewer } from "./bin-start.js";

const HELP = `leglas - compare design directions inside your own running app

Usage
  leglas init                Prepare a project and teach its agents
  leglas [options]           Start the server and open the interface
  leglas new <surface>       Scaffold a branch point for a surface
  leglas explore <surface>   Brief an agent's exploration of a surface, or build it
  leglas classify            Decide where a direction should live
  leglas add --title T --url U   Register a preview on this machine
  leglas list                Show every preview, shared and local
  leglas log [entry]         What past explorations decided
  leglas show <title>        Everything Leglas knows about one direction
  leglas share [title] [title]  Share the rail, one direction or a pair
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
  --count <n>          How many directions (default 3; up to 6 with --build)
  --based-on <title>     Variants of an existing direction instead of new ones
  --build              Build the set with your agent (Claude or Codex) in the
                       running Leglas, instead of printing a brief for an agent
  --brief <text>       What the directions are for (needs --build; optional
                       with --based-on)
  --port <port>        Running Leglas port (needs --build)

Options for watch
  --run <command>      Your agent, with {prompt} where the request goes, for
                       example "claude -p {prompt}". Remembered after first use
  --port <port>        Port Leglas itself is on (default: 4100)
  --json               One JSON line per event; the agent's output goes to stderr

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

Options for share
  --reach <open|listed>  How far viewers reach into the app (default open)
  --tunnel <name>      cloudflared, ngrok or none (default: the first found)
  --stop               End the share, and every link to it
  --port <port>        Running Leglas port
`;

function version(): string {
  const require = createRequire(import.meta.url);
  // SAFETY: The CLI ships its own `package.json`, whose version is required for publishing.
  const pkg = require("../package.json") as { version: string };

  return pkg.version;
}

/** Hand off to the platform's opener; failing to open is not worth aborting for. */
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The URL is already printed; the user can click it.
  }
}

/**
 * Importing a .ts config from a package without `"type": "module"` makes Node
 * warn about reparsing. That warning is ours, not the user's to fix, so drop it
 * and pass the rest through.
 */
function quietModuleTypeWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if ("code" in warning && warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return;

    for (const listener of listeners) listener(warning);
  });
}

quietModuleTypeWarning();

const parsed = parseArgs(process.argv.slice(2));

if (parsed.kind === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

if (parsed.kind === "version") {
  process.stdout.write(`${version()}\n`);
  process.exit(0);
}

if (parsed.kind === "error") {
  process.stderr.write(`${parsed.message}\n`);
  process.exit(2);
}

const previewDeps = {
  log: (line: string) => process.stdout.write(`${line}\n`),
  error: (line: string) => process.stderr.write(`${line}\n`),
};

if (parsed.kind === "init") {
  const outcome = await runInit(
    { cwd: process.cwd(), force: parsed.force, json: parsed.json },
    { log: (line) => process.stdout.write(`${line}\n`) },
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "classify") {
  const outcome = await runClassify(
    { changes: parsed.changes, json: parsed.json, cwd: process.cwd() },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "add") {
  const outcome = await runAdd(
    { preview: parsed.preview, json: parsed.json, cwd: process.cwd() },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "keep") {
  const outcome = await runKeep(
    { title: parsed.title, to: parsed.to, json: parsed.json, cwd: process.cwd() },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "explore" && parsed.build) {
  const outcome = await runExploreBuild(
    {
      surface: parsed.surface,
      brief: parsed.brief ?? "",
      count: parsed.count,
      basedOn: parsed.basedOn,
      json: parsed.json,
      cwd: process.cwd(),
      port: parsed.port,
    },
    {
      log: (line) => process.stdout.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
    },
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "explore") {
  const outcome = runExplore(
    { surface: parsed.surface, count: parsed.count, basedOn: parsed.basedOn, json: parsed.json },
    { log: (line) => process.stdout.write(`${line}\n`) },
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "requests") {
  const outcome = await runRequests(
    { json: parsed.json, clear: parsed.clear, cwd: process.cwd() },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

// Long-running like leglas itself: prints progress (one JSON line per event
// under --json) and returns only once a signal stops it.
if (parsed.kind === "watch") {
  const outcome = await runWatch(
    { run: parsed.run, port: parsed.port, cwd: process.cwd(), json: parsed.json },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "log") {
  const outcome = await runLog(
    { entry: parsed.entry, json: parsed.json, cwd: process.cwd() },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "list") {
  const outcome = await runList({ json: parsed.json, cwd: process.cwd() }, previewDeps);
  process.exit(outcome.exitCode);
}

if (parsed.kind === "share") {
  const outcome = await runShare(
    {
      titles: parsed.titles,
      reach: parsed.reach,
      tunnel: parsed.tunnel,
      stop: parsed.stop,
      port: parsed.port,
      json: parsed.json,
      cwd: process.cwd(),
    },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "show") {
  const outcome = await runShow(
    {
      title: parsed.title,
      json: parsed.json,
      screenshot: parsed.screenshot,
      width: parsed.width,
      port: parsed.port,
      cwd: process.cwd(),
    },
    previewDeps,
  );

  process.exit(outcome.exitCode);
}

if (parsed.kind === "new") {
  const outcome = await runNew(
    {
      surface: parsed.surface,
      print: parsed.print,
      json: parsed.json,
      from: parsed.from,
      cwd: process.cwd(),
    },
    { log: (line) => process.stdout.write(`${line}\n`) },
  );

  process.exit(outcome.exitCode);
}

await startViewer(
  { ...parsed.options, cwd: process.cwd() },
  { entry: fileURLToPath(import.meta.url), version: version(), open: openBrowser },
);
