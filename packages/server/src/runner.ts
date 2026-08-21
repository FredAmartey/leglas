import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { commandFor, nextRequest, parseTemplate } from "./agent-command.js";
import { removeAnnotations } from "./annotations.js";
import {
  createClaudeAgentSession,
  type ClaudeTurnRunner,
} from "./claude-agent-session.js";
import {
  createCodexAppServer,
  type CodexTurnRunner,
} from "./codex-app-server.js";
import { LOCAL_PREVIEWS_PATH } from "./local-previews.js";
import {
  KNOWN_AGENTS,
  activityFrom,
  agentEnvironment,
  readAgentChoice,
  retryFrom,
  sessionFrom,
  type AgentChoice,
  type AgentEffort,
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
  registrationCommand,
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
  /** Injected by app-server tests; null keeps the legacy Codex CLI path. */
  codexAppServer?: CodexTurnRunner | null;
  /** Injected by Agent SDK tests; null keeps the legacy Claude CLI path. */
  claudeAgentSession?: ClaudeTurnRunner | null;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Injected by tests so the cancel grace period does not cost real seconds. */
  setTimeout?: (callback: () => void, milliseconds: number) => void;
  /**
   * How a fork's prompt names the registration CLI, exactly as the prompt
   * composer received it. It feeds the pre-approval a non-interactive CLI
   * needs to run that command; absent, no allowance is granted and a fork
   * behaves as it did before the allowance existed.
   */
  leglasCommand?: string;
};

export type RunningAgent = {
  stop(): Promise<void>;
  snapshot(): RunnerState;
  cancel(id?: string): boolean;
  /** Warm the selected embedded transport without blocking the selection API. */
  prepare(agent: AgentChoice): void;
  /** Look at the queue now instead of on the next poll. */
  nudge(): void;
};

type ResolvedCommand = {
  agent: AgentChoice;
  name: string;
  command: string;
  args: string[];
  prompt: string;
  effort: AgentEffort | null;
  sessionId: string | null;
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
  registration: string | null = null,
): ResolvedCommand | null {
  if (choice.agent === null) return null;

  // A custom template is the user's own command, and its permissions are
  // theirs to configure; nothing is appended to an argv Leglas did not write.
  if (choice.agent === "custom") {
    if (choice.run === null) return null;
    const parsed = parseTemplate(choice.run);
    if (!parsed.ok) return null;
    return {
      agent: "custom",
      name: "Custom",
      ...commandFor(parsed.template, prompt),
      prompt,
      effort: null,
      sessionId: null,
      resumed: false,
    };
  }

  const adapter = KNOWN_AGENTS[choice.agent];
  const allow =
    registration !== null && "allowArgs" in adapter ? adapter.allowArgs(registration) : [];
  if (sessionId !== null && "resumeArgs" in adapter) {
    return {
      agent: choice.agent,
      name: adapter.name,
      command: adapter.binary,
      args: [...adapter.resumeArgs(sessionId, prompt, choice.effort), ...allow],
      prompt,
      effort: choice.effort,
      sessionId,
      resumed: true,
    };
  }
  return {
    agent: choice.agent,
    name: adapter.name,
    command: adapter.binary,
    args: [...adapter.args(prompt, choice.effort), ...allow],
    prompt,
    effort: choice.effort,
    sessionId: null,
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
  return nodeSpawn(command, args, { ...options, env: agentEnvironment() }) as RunnerChild;
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
  const codexAppServer =
    options.codexAppServer === undefined
      ? options.spawn === undefined
        ? createCodexAppServer(options.cwd)
        : null
      : options.codexAppServer;
  const claudeAgentSession =
    options.claudeAgentSession === undefined
      ? options.spawn === undefined
        ? createClaudeAgentSession(
            options.cwd,
            options.leglasCommand === undefined
              ? null
              : registrationCommand(options.leglasCommand),
          )
        : null
      : options.claudeAgentSession;
  // Only the saved vendor is warmed at startup. Selection changes call
  // prepare() too, paying the new vendor's process and handshake while the
  // user composes; an already-warm transport stays ready for a quick switch
  // back until this Leglas server shuts down.
  const prepare = (agent: AgentChoice): void => {
    if (agent === "codex") void codexAppServer?.warm().catch(() => {});
    if (agent === "claude") void claudeAgentSession?.warm().catch(() => {});
  };
  void readAgentChoice(options.cwd)
    .then((choice) => {
      if (choice.agent !== null) prepare(choice.agent);
    })
    .catch(() => {});
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
  // Requests can land while the previous tick is removing its completed queue
  // entry. Count those nudges rather than dropping or coalescing them: each
  // accepted queue addition deserves one immediate successor tick, without
  // ever overlapping the active agent.
  let pendingNudges = 0;
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
    await markFailed(options.cwd, request.id, failure).catch(() => {
      // The queue is unwritable; the in-memory record below still stops a
      // rerun for the life of this process, which is what it did before any
      // of this.
    });
    // Do not expose the in-memory verdict before the durable one. Consumers
    // use failedIds as the signal that the queue is ready to read.
    failed.add(request.id);
    if (failure.code === "cancelled") {
      console.error(`Leglas stopped the run for ${request.title}.`);
      return;
    }
    console.error(`Leglas agent failed for ${request.title}: ${failure.message}`);
    for (const line of lines) console.error(`  ${line}`);
  };

  const runChild = async (
    request: PendingRequest,
    resolved: ResolvedCommand,
    lines: string[],
    observed: { sessionId: string | null; edited: boolean; retry: RetryNotice | null },
  ): Promise<ChildOutcome> => {
    let child: RunnerChild;
    const persistent =
      resolved.agent === "codex"
        ? codexAppServer
        : resolved.agent === "claude"
          ? claudeAgentSession
          : null;
    try {
      child =
        persistent !== null
          ? await persistent.run({
              prompt: resolved.prompt,
              effort: resolved.effort,
              sessionId: resolved.sessionId,
            })
          : spawn(resolved.command, resolved.args, {
              cwd: options.cwd,
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
            });
    } catch (error) {
      // A missing SDK, older Codex build or failed persistent handshake keeps
      // the exact vendor CLI behavior Leglas shipped before this optimization.
      if (persistent !== null) {
        try {
          child = spawn(resolved.command, resolved.args, {
            cwd: options.cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (fallbackError) {
          return {
            ok: false,
            error:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          };
        }
      } else {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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

  /** The previews file as it stands, or null before it exists. */
  const registered = (): Promise<string | null> =>
    readFile(join(options.cwd, LOCAL_PREVIEWS_PATH), "utf8").catch(() => null);

  const handle = async (request: PendingRequest, choice: SavedAgentChoice): Promise<void> => {
    const session =
      choice.agent !== null ? (sessions.get(choice.agent) ?? null) : null;
    const continuable = session !== null && session.turns < SESSION_TURNS_CAP;
    const registration =
      request.mode === "variant" && options.leglasCommand !== undefined
        ? registrationCommand(options.leglasCommand)
        : null;
    let resolved = resolveCommand(
      choice,
      request.prompt,
      continuable ? session.id : null,
      registration,
    );
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
      // A fork's one observable outcome is the previews file gaining its
      // entry, so the file as it stood before the run is what exit 0 gets
      // judged against.
      const before = request.mode === "variant" ? await registered() : null;
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
        const cold = resolveCommand(choice, request.prompt, null, registration);
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
        // An exit 0 that registered nothing is a run that could not or would
        // not finish its last step, and counting it as success is how three
        // runs once vanished without a trace: request removed, card gone, rail
        // unchanged, the agent's explanation discarded. The conversation
        // ignored its final instruction, so it is not resumed either.
        if (request.mode === "variant" && (await registered()) === before) {
          sessions.delete(resolved.agent);
          await reportFailure(request, classifyFailure({ agent, error: "not-registered" }), lines);
          return;
        }
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
        // A change made in place answered its notes by rewriting the design
        // they were left on, so keeping them would leave pins pointing at
        // something that no longer exists. A fork leaves them alone: the
        // direction they point at is exactly as it was.
        if (request.mode === "replace" && request.notes !== undefined) {
          await removeAnnotations(options.cwd, request.notes).catch(() => 0);
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

  const schedule = (remember = false) => {
    if (stopped) return;
    if (ticking !== null) {
      if (remember) pendingNudges += 1;
      return;
    }
    const task = tick();
    ticking = task;
    void task
      .catch((error) =>
        console.error(`Leglas runner: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (ticking === task) ticking = null;
        if (pendingNudges > 0 && !stopped) {
          pendingNudges -= 1;
          schedule();
        }
      });
  };

  const timer = setEvery(() => schedule(), POLL_MS);
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
      .then(() =>
        Promise.all([
          codexAppServer?.close(),
          claudeAgentSession?.close(),
        ]),
      )
      .then(() => {});
    return stopPromise;
  };

  return {
    stop,
    snapshot: () => ({ ...state, failedIds: [...failed] }),
    cancel,
    prepare,
    // A nudge during a tick is latched and checked as soon as that tick
    // settles; a nudge between ticks starts immediately. Neither can overlap
    // the active agent.
    nudge: () => schedule(true),
  };
}
