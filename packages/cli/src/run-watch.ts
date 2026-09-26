import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_PORT,
  KNOWN_AGENTS,
  LEGLAS_PREFIX,
  PROMPT_TOKEN,
  classifyFailure,
  markFailed,
  markPickedUp,
  readAgentChoice,
  readRequests,
  removeRequest,
  type PendingRequest,
} from "@leglas/server";

import { WATCH_PATH, commandFor, nextRequest, parseTemplate, type WatchTemplate } from "./watch.js";
import { isJsonObject, type JsonValue } from "./json.js";

export type WatchDeps = { log(line: string): void; error(line: string): void };

/**
 * How often the queue is read. A poll, not fs.watch: files are written by
 * rename, which fs.watch reports inconsistently across platforms.
 */
const POLL_MS = 2000;

/** A heartbeat is worth a moment, never a stall. */
const HEARTBEAT_TIMEOUT_MS = 1000;

type SpawnOutcome = { ok: true; code: number } | { ok: false; error: string };

/** One line of `watch --json`, as docs/cli.md lists them. */
type WatchEvent =
  | { event: "watching"; command: string; agent: string | null }
  | { event: "started"; id: string; title: string; intent: string; target: string | null }
  | { event: "done"; id: string; title: string }
  | { event: "failed"; id: string; title: string; code: string; reason: string }
  | { event: "error"; message: string }
  | { event: "stopped" };

async function saveTemplate(cwd: string, run: string): Promise<void> {
  const path = join(cwd, WATCH_PATH);
  // The file also holds the interface's agent choice, so the template joins it;
  // overwriting would switch the embedded runner off.
  let config: { [key: string]: JsonValue } = {};

  try {
    const parsed: JsonValue = JSON.parse(await readFile(path, "utf8"));

    if (isJsonObject(parsed)) config = parsed;
  } catch {
    // Never watched here before; an empty config is the whole story.
  }

  config.run = run;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Runs the agent on one prompt. No shell, since the prompt is arbitrary browser
 * text. stdio is inherited so the agent's output shows in this terminal as it
 * works; under --json its stdout goes to stderr so stdout stays events only.
 */
function spawnAgent(
  command: string,
  args: string[],
  cwd: string,
  json: boolean,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const child = spawn(command, args, {
      cwd,
      stdio: json ? ["inherit", 2, "inherit"] : "inherit",
    });

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
 * Hands change requests to the user's own agent as they arrive, with the user's
 * keys and model; Leglas runs none. Resolves when a signal stops the watcher,
 * so the caller looks like every other command.
 */
export async function runWatch(
  options: {
    run: string | undefined;
    port: number | undefined;
    cwd: string;
    json?: boolean;
    signal?: AbortSignal;
  },
  deps: WatchDeps,
): Promise<{ exitCode: number }> {
  // Under --json stdout is events only, and a refusal is the envelope every
  // other command prints.
  const json = options.json === true;
  const emit = (event: WatchEvent): void => deps.log(JSON.stringify(event));

  const refuse = (error: string) => {
    if (json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  const saved =
    options.run === undefined ? await readAgentChoice(options.cwd) : { agent: null, run: null };

  const raw = options.run ?? saved.run;
  let template: WatchTemplate;
  let shownCommand: string;
  let synthesizedAgent: string | null = null;

  if (raw !== null) {
    const parsed = parseTemplate(raw);

    if (!parsed.ok) return refuse(parsed.error);

    template = parsed.template;
    shownCommand = raw;
  } else if (saved.agent !== null && saved.agent !== "custom") {
    const adapter = KNOWN_AGENTS[saved.agent];
    template = {
      command: adapter.binary,
      args: adapter.terminalArgs(PROMPT_TOKEN, saved.effort),
    };
    shownCommand = [template.command, ...template.args].join(" ");
    synthesizedAgent = adapter.name;
  } else {
    return refuse(
      'Watch needs an agent command the first time: pick an agent in the interface, or pass --run "claude -p {prompt}".',
    );
  }

  // An explicit template is saved once known good. A synthesized one stays
  // derived from the saved agent choice so the two can't drift.
  if (options.run !== undefined) await saveTemplate(options.cwd, options.run).catch(() => {});

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
      // Leglas may be down or on another port. The queue is a file either way;
      // only the interface's "your agent is listening" needs this.
    }
  };

  if (json) {
    emit({ event: "watching", command: shownCommand, agent: synthesizedAgent });
  } else {
    if (synthesizedAgent !== null) {
      deps.log(`Using ${synthesizedAgent}, chosen in the interface.`);
    }

    deps.log(`Watching for change requests. Each one runs: ${shownCommand}`);
    deps.log("Stop with Ctrl-C.");
  }

  const failed = new Set<string>();
  let stopped = false;
  let busy = false;
  let announced = false;
  /** The request being handled right now, so a stop can wait for its books. */
  let inflight: Promise<void> | null = null;

  const handle = async (request: PendingRequest): Promise<void> => {
    const { id, title, intent, target } = request;

    if (json) {
      emit({ event: "started", id, title, intent, target });
    } else {
      deps.log("");
      deps.log(`  ${title}: ${intent}`);

      if (target !== null) deps.log(`    ${target}`);
    }

    // Saved before the agent starts, so the interface stops saying the request
    // is waiting.
    await markPickedUp(options.cwd, request.id);

    const { command, args } = commandFor(template, request.prompt);
    const outcome = await spawnAgent(command, args, options.cwd, json);

    if (outcome.ok && outcome.code === 0) {
      await removeRequest(options.cwd, request.id);

      if (json) emit({ event: "done", id, title });
      else deps.log(`  done    ${title}`);

      return;
    }

    // Never offered again: a prompt that broke the agent will break it again,
    // at the user's cost. The verdict goes into the queue so the interface can
    // show it and the next watcher skips it. The agent's output went straight
    // to this terminal, so the reason is only what the outcome says.
    failed.add(request.id);

    const failure = classifyFailure({
      agent: (shownCommand.split(/\s+/)[0] ?? command).split("/").pop() ?? command,
      error: outcome.ok ? null : outcome.error,
      exitCode: outcome.ok ? outcome.code : null,
    });

    await markFailed(options.cwd, request.id, failure);

    if (json) {
      emit({ event: "failed", id, title, code: failure.code, reason: failure.message });
    } else {
      deps.error(`  failed  ${title}: ${failure.message}`);
      deps.error("  Left in the queue and not retried.");
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    // The first beat is awaited: the runner backs off once the server registers
    // a watcher, so reading the queue before then lets both spawn for one
    // request. Later beats are fire-and-forget.
    if (announced) {
      void heartbeat(true);
    } else {
      await heartbeat(true);
      announced = true;
    }

    // One agent at a time, in queue order, so two never edit one tree.
    if (busy) return;
    busy = true;

    try {
      const request = nextRequest(await readRequests(options.cwd), failed);

      if (request !== null && !stopped) {
        inflight = handle(request);
        await inflight;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (json) emit({ event: "error", message });
      else deps.error(`  ! ${message}`);
    } finally {
      inflight = null;
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
      // A running agent shares this process group, so Ctrl-C reached it too.
      // Its bookkeeping must still land before this settles, since the caller
      // exits on it and a successful request would be stranded as picked-up.
      // The last heartbeat is best effort.
      void Promise.resolve(inflight)
        .catch(() => {})
        .then(() => heartbeat(false))
        .then(() => {
          if (json) emit({ event: "stopped" });
          resolve({ exitCode: 0 });
        });
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The programmatic Ctrl-C, mostly for tests.
    options.signal?.addEventListener("abort", stop, { once: true });

    // The signal may have fired during the awaited setup above, and a listener
    // added to an aborted signal never fires.
    if (options.signal?.aborted === true) return stop();
    void tick();
  });
}
