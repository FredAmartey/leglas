import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

import { createUpdateService } from "@leglas/server";

import type { RunOptions } from "./args.js";
import { createHandoff } from "./restart.js";
import { run } from "./run.js";
import { installShutdown } from "./shutdown.js";

type HandoffDeps = Parameters<ReturnType<typeof createHandoff>["handOff"]>[2];

/** Wire the long-running CLI instance to its updater and signal handlers. */
export async function startViewer(
  options: RunOptions & { cwd: string },
  deps: {
    entry: string;
    version: string;
    open(url: string): Promise<void>;
    realpath?: (path: string) => string;
    createUpdateService?: typeof createUpdateService;
    run?: typeof run;
    installShutdown?: typeof installShutdown;
    /** Where a restart spawns and how either shutdown ends the process. */
    handoff?: HandoffDeps;
  },
): Promise<void> {
  let entry = deps.entry;

  try {
    entry = (deps.realpath ?? realpathSync)(entry);
  } catch {
    // A removed cache entry must not prevent startup from the unresolved path.
  }

  const updates = (deps.createUpdateService ?? createUpdateService)({
    version: deps.version,
    entry,
    argv: process.argv,
    cwd: options.cwd,
    deps: {
      log: (line) => (options.json ? process.stderr : process.stdout).write(`${line}\n`),
    },
  });

  const result = await (deps.run ?? run)(options, {
    open: deps.open,
    log: (line) => process.stdout.write(`${line}\n`),
    updates,
  });

  const { handOff, handedOff } = createHandoff();

  const handoff = deps.handoff ?? {
    spawn,
    exit: (code) => process.exit(code),
    target: process,
  };

  updates.onRestart((command) => handOff(command, result.stop, handoff));

  (deps.installShutdown ?? installShutdown)(async () => {
    if (handedOff()) return;
    await result.stop();
    handoff.exit(0);
  });
}
