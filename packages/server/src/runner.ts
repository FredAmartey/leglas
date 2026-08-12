import { spawn as nodeSpawn } from "node:child_process";

import { commandFor, nextRequest, parseTemplate } from "./agent-command.js";
import {
  KNOWN_AGENTS,
  activityFrom,
  readAgentChoice,
  type AgentChoice,
  type SavedAgentChoice,
} from "./agents.js";
import { markPickedUp, readRequests, removeRequest, type PendingRequest } from "./requests.js";

const POLL_MS = 2000;
const OUTPUT_LINES = 20;

export type RunnerState = {
  running: boolean;
  requestId: string | null;
  agent: string | null;
  activity: string | null;
  startedAt: number | null;
  failedIds: readonly string[];
};

type ActiveRunnerState = Omit<RunnerState, "failedIds">;

export type RunnerChild = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): RunnerChild;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): RunnerChild;
  kill(signal: NodeJS.Signals): boolean;
};

export type RunnerSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => RunnerChild;

export type RunnerOptions = {
  cwd: string;
  externallyAttached: () => boolean;
  spawn?: RunnerSpawn;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export type RunningAgent = {
  stop(): Promise<void>;
  snapshot(): RunnerState;
  cancel(id?: string): boolean;
};

type ResolvedCommand = {
  agent: AgentChoice;
  name: string;
  command: string;
  args: string[];
};

type ChildOutcome =
  | { ok: true; code: number }
  | { ok: false; error: string };

function resolveCommand(choice: SavedAgentChoice, prompt: string): ResolvedCommand | null {
  if (choice.agent === null) return null;

  if (choice.agent === "custom") {
    if (choice.run === null) return null;
    const parsed = parseTemplate(choice.run);
    if (!parsed.ok) return null;
    return { agent: "custom", name: "Custom", ...commandFor(parsed.template, prompt) };
  }

  const adapter = KNOWN_AGENTS[choice.agent];
  return {
    agent: choice.agent,
    name: adapter.name,
    command: adapter.binary,
    args: adapter.args(prompt),
  };
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  let buffered = "";
  const flush = () => {
    if (buffered === "") return;
    onLine(buffered.replace(/\r$/, ""));
    buffered = "";
  };

  stream.on("data", (chunk: string | Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  });
  stream.on("end", flush);
  return flush;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"] },
): RunnerChild {
  return nodeSpawn(command, args, options) as RunnerChild;
}

/**
 * Run queued requests through the chosen local agent, one at a time.
 *
 * The external watcher gets first refusal because it is already showing the
 * agent's live output in a terminal. Starting a second agent here would make
 * both processes edit the same tree and charge the user for duplicate work.
 */
export function startRunner(options: RunnerOptions): RunningAgent {
  const spawn = options.spawn ?? defaultSpawn;
  const setEvery = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearEvery = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const failed = new Set<string>();

  let state: ActiveRunnerState = {
    running: false,
    requestId: null,
    agent: null,
    activity: null,
    startedAt: null,
  };
  let stopped = false;
  let ticking: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let active: { child: RunnerChild; requestId: string; cancelled: boolean } | null = null;

  const idle = () => {
    state = { running: false, requestId: null, agent: null, activity: null, startedAt: null };
  };

  const rememberLine = (lines: string[], line: string) => {
    lines.push(line);
    if (lines.length > OUTPUT_LINES) lines.splice(0, lines.length - OUTPUT_LINES);
  };

  const reportFailure = (request: PendingRequest, error: string, lines: readonly string[]) => {
    console.error(`Leglas agent failed for ${request.title}: ${error}`);
    for (const line of lines) console.error(`  ${line}`);
  };

  const runChild = (
    request: PendingRequest,
    resolved: ResolvedCommand,
    lines: string[],
  ): Promise<ChildOutcome> => {
    let child: RunnerChild;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const current = { child, requestId: request.id, cancelled: false };
    active = current;

    const stdoutFlush = lineReader(child.stdout, (line) => {
      rememberLine(lines, line);
      const activity = activityFrom(resolved.agent, line, options.cwd);
      if (activity !== null && active === current) state = { ...state, activity };
    });
    const stderrFlush = lineReader(child.stderr, (line) => rememberLine(lines, line));

    return new Promise<ChildOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: ChildOutcome) => {
        if (settled) return;
        settled = true;
        stdoutFlush();
        stderrFlush();
        resolve(outcome);
      };

      child.once("error", (error) => settle({ ok: false, error: error.message }));
      child.once("close", (code, signal) => {
        if (current.cancelled) return settle({ ok: false, error: "cancelled" });
        if (signal !== null) return settle({ ok: false, error: `stopped by ${signal}` });
        settle({ ok: true, code: code ?? 0 });
      });
    }).finally(() => {
      if (active === current) active = null;
    });
  };

  const handle = async (request: PendingRequest, choice: SavedAgentChoice): Promise<void> => {
    const resolved = resolveCommand(choice, request.prompt);
    if (resolved === null) return;

    const lines: string[] = [];

    try {
      // If an external collector won the race after the queue read, it owns
      // this request. The false return is the lock we get from the queue file.
      if (!(await markPickedUp(options.cwd, request.id))) return;
      // Stop may have landed while the queue write was in flight, before a
      // child existed for cancel() to signal. Leave the picked-up request as a
      // failed handoff instead of starting new work during shutdown.
      if (stopped) {
        failed.add(request.id);
        return;
      }
      // Wall-clock rather than injected time: the value only feeds the elapsed
      // counter in the shell, which reads it against its own Date.now anyway.
      state = {
        running: true,
        requestId: request.id,
        agent: resolved.name,
        activity: null,
        startedAt: Date.now(),
      };
      const outcome = await runChild(request, resolved, lines);

      if (outcome.ok && outcome.code === 0) {
        await removeRequest(options.cwd, request.id);
        return;
      }

      failed.add(request.id);
      reportFailure(
        request,
        outcome.ok ? `${resolved.command} exited ${outcome.code}` : outcome.error,
        lines,
      );
    } finally {
      idle();
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const choice = await readAgentChoice(options.cwd);
    if (choice.agent === null || stopped) return;
    if (options.externallyAttached()) return;

    const request = nextRequest(await readRequests(options.cwd), failed);
    if (request !== null && !stopped) await handle(request, choice);
  };

  const schedule = () => {
    if (stopped || ticking !== null) return;
    const task = tick();
    ticking = task;
    void task
      .catch((error) =>
        console.error(`Leglas runner: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (ticking === task) ticking = null;
      });
  };

  const timer = setEvery(schedule, POLL_MS);
  schedule();

  const cancel = (id?: string): boolean => {
    if (active === null || active.cancelled) return false;
    // A stop aimed at a specific request must not land on its successor: in
    // the gap between one run ending and the next starting, the card the user
    // clicked may describe a run that no longer exists. Refusing the mismatch
    // makes that click a no-op instead of a misfire.
    if (id !== undefined && active.requestId !== id) return false;
    active.cancelled = true;
    failed.add(active.requestId);
    try {
      active.child.kill("SIGTERM");
    } catch {
      // The close or error event still settles the run if the process raced us.
    }
    return true;
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    clearEvery(timer);
    cancel();
    stopPromise = Promise.resolve(ticking)
      .catch(() => {})
      .then(() => {});
    return stopPromise;
  };

  return {
    stop,
    snapshot: () => ({ ...state, failedIds: [...failed] }),
    cancel,
  };
}
