import { spawn as nodeSpawn } from "node:child_process";

import { commandFor, nextRequest, parseTemplate } from "./agent-command.js";
import {
  KNOWN_AGENTS,
  activityFrom,
  readAgentChoice,
  retryFrom,
  sessionFrom,
  type AgentChoice,
  type SavedAgentChoice,
} from "./agents.js";
import {
  classifyFailure,
  sessionShaped,
  type Failure,
  type RetryNotice,
} from "./failure.js";
import {
  markFailed,
  markPickedUp,
  readRequests,
  removeRequest,
  type PendingRequest,
} from "./requests.js";

const POLL_MS = 2000;
const OUTPUT_LINES = 20;

/**
 * How long a stopped run has to end itself before Leglas stops waiting.
 *
 * SIGTERM is the polite ask and an agent that honours it is gone in well
 * under a second. What this bounds is the run that does not end: a CLI that
 * traps the signal, or a wrapper whose own child outlives it still holding
 * the output pipe open, in which case the "close" event never arrives at all.
 * Until this existed that wedged the runner for the life of the process: the
 * card said a stopped run was still going, no verdict was ever written, and
 * every request queued behind it waited on a child that was never coming
 * back. The escalation only ever follows a stop the user asked for.
 */
const CANCEL_GRACE_MS = 5000;

export type RunnerState = {
  running: boolean;
  requestId: string | null;
  agent: string | null;
  activity: string | null;
  startedAt: number | null;
  /** True between a stop being asked for and the child actually going. */
  stopping: boolean;
  /**
   * The retry the vendor CLI is sitting in, while it is sitting in one. This
   * is the difference between a run that looks wedged and a run that says it
   * is waiting on an overloaded provider; Leglas cannot shorten the vendor's
   * backoff, but it can stop the wait being a mystery.
   */
  waiting: RetryNotice | null;
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
  /** Injected by tests so the cancel grace period does not cost real seconds. */
  setTimeout?: (callback: () => void, milliseconds: number) => void;
};

export type RunningAgent = {
  stop(): Promise<void>;
  snapshot(): RunnerState;
  cancel(id?: string): boolean;
  /** Look at the queue now instead of on the next poll. */
  nudge(): void;
};

type ResolvedCommand = {
  agent: AgentChoice;
  name: string;
  command: string;
  args: string[];
  /** True when the argv continues a saved session instead of starting cold. */
  resumed: boolean;
};

type ChildOutcome =
  | { ok: true; code: number }
  | { ok: false; error: string };

/**
 * How many requests may share one vendor session before the next one starts
 * fresh. Every resumed turn carries the whole conversation back to the
 * model, so an unbounded session quietly makes each request dearer than the
 * last; eight keeps the discount while capping the freight.
 */
const SESSION_TURNS_CAP = 8;

function resolveCommand(
  choice: SavedAgentChoice,
  prompt: string,
  sessionId: string | null = null,
): ResolvedCommand | null {
  if (choice.agent === null) return null;

  if (choice.agent === "custom") {
    if (choice.run === null) return null;
    const parsed = parseTemplate(choice.run);
    if (!parsed.ok) return null;
    return { agent: "custom", name: "Custom", ...commandFor(parsed.template, prompt), resumed: false };
  }

  const adapter = KNOWN_AGENTS[choice.agent];
  if (sessionId !== null && "resumeArgs" in adapter) {
    return {
      agent: choice.agent,
      name: adapter.name,
      command: adapter.binary,
      args: adapter.resumeArgs(sessionId, prompt),
      resumed: true,
    };
  }
  return {
    agent: choice.agent,
    name: adapter.name,
    command: adapter.binary,
    args: adapter.args(prompt),
    resumed: false,
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

  const setLater =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number) => {
      // Unrefed: a grace period still counting down must never be the reason
      // a process stays alive.
      setTimeout(callback, milliseconds).unref?.();
    });

  let state: ActiveRunnerState = {
    running: false,
    requestId: null,
    agent: null,
    activity: null,
    startedAt: null,
    stopping: false,
    waiting: null,
  };
  let stopped = false;
  let ticking: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let active: {
    child: RunnerChild;
    requestId: string;
    cancelled: boolean;
    /** Settle the run as stopped without waiting for the child's streams. */
    abandon: () => void;
  } | null = null;

  /**
   * The vendor session each agent may continue, per this server process.
   * In memory on purpose: a session that outlives the process would come
   * back stale after days, and the vendor may have cleaned it up anyway.
   * Dropped on any failure or cancel so a wedged conversation cannot taint
   * the requests after it.
   */
  const sessions = new Map<AgentChoice, { id: string; turns: number }>();

  const idle = () => {
    state = {
      running: false,
      requestId: null,
      agent: null,
      activity: null,
      startedAt: null,
      stopping: false,
      waiting: null,
    };
  };

  const rememberLine = (lines: string[], line: string) => {
    lines.push(line);
    if (lines.length > OUTPUT_LINES) lines.splice(0, lines.length - OUTPUT_LINES);
  };

  /**
   * Write the verdict where the interface and the next process can both read
   * it, and put the agent's own last words in the terminal running Leglas.
   *
   * The output stays here rather than travelling to the browser: twenty lines
   * of vendor log can carry a prompt, a path or a token, and the card only
   * needs to say what happened and what to do about it.
   */
  const reportFailure = async (
    request: PendingRequest,
    failure: Failure,
    lines: readonly string[],
  ): Promise<void> => {
    failed.add(request.id);
    await markFailed(options.cwd, request.id, failure).catch(() => {
      // The queue is unwritable; the in-memory record still stops a rerun for
      // the life of this process, which is what it did before any of this.
    });
    if (failure.code === "cancelled") {
      console.error(`Leglas stopped the run for ${request.title}.`);
      return;
    }
    console.error(`Leglas agent failed for ${request.title}: ${failure.message}`);
    for (const line of lines) console.error(`  ${line}`);
  };

  const runChild = (
    request: PendingRequest,
    resolved: ResolvedCommand,
    lines: string[],
    observed: { sessionId: string | null; edited: boolean; retry: RetryNotice | null },
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

    const current = {
      child,
      requestId: request.id,
      cancelled: false,
      abandon: () => {},
    };
    active = current;

    const stdoutFlush = lineReader(child.stdout, (line) => {
      rememberLine(lines, line);
      const sessionId = sessionFrom(resolved.agent, line);
      if (sessionId !== null) observed.sessionId = sessionId;
      const retry = retryFrom(resolved.agent, line);
      if (retry !== null) {
        observed.retry = retry;
        if (active === current) state = { ...state, waiting: retry };
      }
      const activity = activityFrom(resolved.agent, line, options.cwd);
      if (activity !== null) {
        if (activity.startsWith("editing")) observed.edited = true;
        // Work resuming ends the wait: the backoff is over the moment the
        // agent says anything else.
        if (active === current) state = { ...state, activity, waiting: null };
      }
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
      current.abandon = () => settle({ ok: false, error: "cancelled" });

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
    const session =
      choice.agent !== null ? (sessions.get(choice.agent) ?? null) : null;
    const continuable = session !== null && session.turns < SESSION_TURNS_CAP;
    let resolved = resolveCommand(choice, request.prompt, continuable ? session.id : null);
    if (resolved === null) return;

    const lines: string[] = [];

    try {
      // If an external collector won the race after the queue read, it owns
      // this request. The false return is the lock we get from the queue file.
      if (!(await markPickedUp(options.cwd, request.id))) return;
      // Stop may have landed while the queue write was in flight, before a
      // child existed for cancel() to signal. Record the handoff as ended by
      // the shutdown instead of starting new work, and instead of leaving a
      // picked-up request the next process would read as live.
      if (stopped) {
        await reportFailure(
          request,
          classifyFailure({ agent: resolved.name, error: "stopped by shutdown" }),
          [],
        );
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
        stopping: false,
        waiting: null,
      };
      const observed = {
        sessionId: null as string | null,
        edited: false,
        retry: null as RetryNotice | null,
      };
      // The name is read once: a cold rerun resolves the same vendor, and a
      // closure over the mutable binding would only be harder to read.
      const agent = resolved.name;
      let outcome = await runChild(request, resolved, lines, observed);
      const verdict = (): Failure =>
        classifyFailure({
          agent,
          error: outcome.ok ? null : stopped && outcome.error === "cancelled"
            ? "stopped by shutdown"
            : outcome.error,
          exitCode: outcome.ok ? outcome.code : null,
          lines,
          retry: observed.retry,
        });
      let failure = verdict();

      // A resume that died without touching a file is a session problem, not
      // a request problem: the vendor may simply have cleaned the session up.
      // One cold retry keeps that invisible to the user. A resume that edited
      // and then failed is treated as any failure, because rerunning it could
      // stack half-applied changes. The edited flag leans on activityFrom
      // labelling every edit attempt; a vendor event stripped of its path
      // data would slip past it, which is accepted, documented coupling.
      //
      // The verdict gates it too, and that is the difference between one
      // provider turn and two: an overloaded provider, a spent limit, a
      // signed-out CLI or a refused directory answers the second run exactly
      // as it answered the first. Claude alone retries an overload ten times
      // over roughly 200 seconds before it exits, so a blind rerun aims a
      // second ladder at a provider that is already down, on the user's
      // account.
      if (
        !(outcome.ok && outcome.code === 0) &&
        resolved.resumed &&
        !observed.edited &&
        sessionShaped(failure.code) &&
        // Not redundant with the verdict: a stop that lands between the first
        // child settling and the retry starting finds no child to cancel, so
        // nothing says "cancelled". Stopped still means stopped.
        !stopped
      ) {
        sessions.delete(resolved.agent);
        const cold = resolveCommand(choice, request.prompt);
        if (cold !== null) {
          resolved = cold;
          observed.sessionId = null;
          observed.retry = null;
          // The failed attempt's last activity must not caption the fresh one.
          state = { ...state, activity: null, waiting: null };
          outcome = await runChild(request, resolved, lines, observed);
          failure = verdict();
        }
      }

      if (outcome.ok && outcome.code === 0) {
        if (observed.sessionId !== null) {
          const previous = sessions.get(resolved.agent);
          sessions.set(resolved.agent, {
            id: observed.sessionId,
            turns:
              resolved.resumed && previous?.id === observed.sessionId
                ? previous.turns + 1
                : 1,
          });
        }
        await removeRequest(options.cwd, request.id);
        return;
      }

      sessions.delete(resolved.agent);
      await reportFailure(request, failure, lines);
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
    const current = active;
    current.cancelled = true;
    failed.add(current.requestId);
    // The card stops claiming the run is live the moment the stop is asked
    // for, rather than whenever the child gets around to going.
    state = { ...state, stopping: true, waiting: null };
    try {
      current.child.kill("SIGTERM");
    } catch {
      // The close or error event still settles the run if the process raced us.
    }
    setLater(() => {
      // Already settled: the child went, and this run is somebody else's now.
      if (active !== current) return;
      try {
        current.child.kill("SIGKILL");
      } catch {
        // Nothing left to signal; the run is settled below either way.
      }
      current.abandon();
    }, CANCEL_GRACE_MS);
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
    // schedule already refuses to overlap a tick in flight, so a nudge during
    // a run costs nothing and a nudge between runs starts the next one now.
    nudge: schedule,
  };
}
