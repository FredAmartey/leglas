import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_PORT,
  LEGLAS_PREFIX,
  markPickedUp,
  readRequests,
  removeRequest,
  type PendingRequest,
} from "@leglas/server";

import { WATCH_PATH, commandFor, nextRequest, parseTemplate, type WatchTemplate } from "./watch.js";

export type WatchDeps = { log(line: string): void; error(line: string): void };

/**
 * How often the queue is read. Deliberately a poll and not fs.watch: editors
 * and agents write files by rename, which fs.watch reports inconsistently
 * across platforms, and the queue is a handful of lines.
 */
const POLL_MS = 2000;

/** A heartbeat is worth a moment, never a stall. */
const HEARTBEAT_TIMEOUT_MS = 1000;

type SpawnOutcome = { ok: true; code: number } | { ok: false; error: string };

async function readSavedTemplate(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, WATCH_PATH), "utf8");
    const parsed = JSON.parse(raw) as { run?: unknown };
    return typeof parsed.run === "string" && parsed.run !== "" ? parsed.run : null;
  } catch {
    // Never watched here before, or the file is unreadable. Both mean the same
    // thing to the caller: there is no remembered command.
    return null;
  }
}

async function saveTemplate(cwd: string, run: string): Promise<void> {
  const path = join(cwd, WATCH_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ run }, null, 2)}\n`, "utf8");
}

/**
 * Run the agent on one prompt.
 *
 * No shell: the prompt is arbitrary text typed into a browser, and a shell
 * would read it as syntax. stdio is inherited so the agent's own output lands
 * in this terminal as it happens, which is what makes watch a thing worth
 * leaving open rather than a wrapper that hides the work.
 */
function spawnAgent(command: string, args: string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error) => settle({ ok: false, error: error.message }));
    child.on("close", (code, signal) =>
      settle(
        signal === null
          ? { ok: true, code: code ?? 0 }
          : { ok: false, error: `stopped by ${signal}` },
      ),
    );
  });
}

/**
 * Hand change requests to the user's own agent as they arrive.
 *
 * This is the whole live loop: the interface writes a request, watch picks it
 * up, the user's agent does the work with the user's keys and the user's model.
 * Leglas still runs no model of its own. What it adds is locality, so asking
 * for a change no longer means leaving the comparison for a terminal.
 *
 * Resolves when the watcher stops, which is what a signal does, so the caller
 * stays the same shape as every other command.
 */
export async function runWatch(
  options: { run: string | undefined; port: number | undefined; cwd: string },
  deps: WatchDeps,
): Promise<{ exitCode: number }> {
  const saved = options.run === undefined ? await readSavedTemplate(options.cwd) : null;
  const raw = options.run ?? saved;

  if (raw === null) {
    deps.error(
      'Watch needs an agent command the first time: leglas watch --run "claude -p {prompt}"',
    );
    return { exitCode: 1 };
  }

  const parsed = parseTemplate(raw);
  if (!parsed.ok) {
    deps.error(parsed.error);
    return { exitCode: 1 };
  }
  const template: WatchTemplate = parsed.template;

  // Remembered as soon as it is known good, so the next run needs no flag. A
  // command that cannot be written down still watches: this is a convenience,
  // not the feature.
  if (options.run !== undefined) await saveTemplate(options.cwd, raw).catch(() => {});

  const base = `http://localhost:${options.port ?? DEFAULT_PORT}`;
  const heartbeat = async (watching: boolean): Promise<void> => {
    try {
      await fetch(`${base}${LEGLAS_PREFIX}/api/watch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watching }),
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });
    } catch {
      // Leglas may not be running, or may have bound another port. The queue is
      // a file either way, so the loop works regardless; only the interface's
      // "your agent is listening" depends on this landing.
    }
  };

  deps.log(`Watching for change requests. Each one runs: ${raw}`);
  deps.log("Stop with Ctrl-C.");

  const failed = new Set<string>();
  let stopped = false;
  let busy = false;

  const handle = async (request: PendingRequest): Promise<void> => {
    deps.log("");
    deps.log(`  ${request.title}: ${request.intent}`);
    if (request.target !== null) deps.log(`    ${request.target}`);

    // Persisted before the agent starts, so the interface stops saying the
    // request is waiting the moment it is not.
    await markPickedUp(options.cwd, request.id);

    const { command, args } = commandFor(template, request.prompt);
    const outcome = await spawnAgent(command, args, options.cwd);

    if (outcome.ok && outcome.code === 0) {
      await removeRequest(options.cwd, request.id);
      deps.log(`  done    ${request.title}`);
      return;
    }

    // Left in the queue as picked-up and never offered again: a prompt that
    // broke the agent will break it the same way in two seconds, and the user
    // is the one paying for the retry. They can see what happened above.
    failed.add(request.id);
    deps.error(
      `  failed  ${request.title}: ${outcome.ok ? `${command} exited ${outcome.code}` : outcome.error}`,
    );
    deps.error("  Left in the queue and not retried.");
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    void heartbeat(true);
    // One agent at a time, in queue order. Two of them editing one tree would
    // produce a conflict the user has to untangle by hand.
    if (busy) return;
    busy = true;
    try {
      const request = nextRequest(await readRequests(options.cwd), failed);
      if (request !== null && !stopped) await handle(request);
    } catch (error) {
      deps.error(`  ! ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  };

  return new Promise((resolve) => {
    const timer = setInterval(() => void tick(), POLL_MS);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      // An agent still running shares this terminal's process group, so Ctrl-C
      // reached it too; nothing here has to kill it. The last heartbeat is
      // best-effort, and the window it opens closes on its own in six seconds.
      void heartbeat(false).then(() => resolve({ exitCode: 0 }));
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    void tick();
  });
}
