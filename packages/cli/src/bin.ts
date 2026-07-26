#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { parseArgs } from "./args.js";
import { runNew } from "./run-new.js";
import { run } from "./run.js";

const HELP = `leglas - compare design directions inside your own running app

Usage
  leglas [options]           Start the server and open the interface
  leglas new <surface>       Scaffold a branch point for a surface

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
`;

function version(): string {
  const require = createRequire(import.meta.url);
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
 * Importing a .ts config from a project whose package.json has no
 * `"type": "module"` makes Node warn about reparsing. That is our config
 * choice leaking into the user's terminal, and asking them to change their
 * app's package.json to quiet our tool would be backwards. Drop that one
 * warning; pass everything else through.
 */
function quietModuleTypeWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if ((warning as NodeJS.ErrnoException).code === "MODULE_TYPELESS_PACKAGE_JSON") return;
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

if (parsed.kind === "new") {
  const outcome = await runNew(
    { surface: parsed.surface, print: parsed.print, cwd: process.cwd() },
    { log: (line) => process.stdout.write(`${line}\n`) },
  );
  process.exit(outcome.exitCode);
}

const result = await run(
  { ...parsed.options, cwd: process.cwd() },
  { open: openBrowser, log: (line) => process.stdout.write(`${line}\n`) },
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await result.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
