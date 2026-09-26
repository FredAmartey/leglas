import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isOwnCapture } from "../requests/attachments.js";
import { commandFor, nextRequest, parseTemplate } from "./agent-command.js";
import { removeAnnotations } from "../requests/annotations.js";
import { createClaudeAgentSession, type ClaudeTurnRunner } from "./claude-agent-session.js";
import { createCodexAppServer, type CodexTurnRunner } from "./codex-app-server.js";
import { LOCAL_PREVIEWS_PATH } from "../config/local-previews.js";
import {
  KNOWN_AGENTS,
  activityFrom,
  activityVerified,
  agentEnvironment,
  readAgentChoice,
  retryFrom,
  sessionFrom,
  type AgentChoice,
  type AgentEffort,
  type SavedAgentChoice,
} from "./agents.js";
import { classifyFailure, conversationFailure, type Failure, type RetryNotice } from "./failure.js";
import {
  markFailed,
  markPickedUp,
  readRequests,
  registrationCommand,
  removeRequest,
  type PendingRequest,
} from "../requests/requests.js";
import type { TimerHandle } from "../timers.js";
import { ownGroup, signalTree } from "./process-tree.js";
import { QUIET_NOTICE_MS, SILENCE_CEILING_MS } from "./silence.js";

const POLL_MS = 2000;

const OUTPUT_LINES = 20;

/**
 * How long a warm transport outlives its last use or ask. A warm transport is a
 * vendor process plus every MCP server the user configured, close to 600MB with
 * a handful of them. Five minutes covers reading two directions and coming back
 * to the composer.
 */
export const IDLE_RELEASE_MS = 5 * 60_000;

/**
 * How long a stopped run has to end before Leglas stops waiting. An agent that
 * honours SIGTERM is gone in under a second, and a spawned agent's whole
 * process group gets the signal. This bounds the run that doesn't end: a CLI
 * that traps the signal, a transport turn that ignores its interrupt, or a
 * stray process holding the output pipe so "close" never comes. That used to
 * wedge the runner for good. Escalation only follows a stop, the user's or the
 * silence ceiling's.
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
   * The retry the vendor CLI is sitting in, if any, so a run waiting on an
   * overloaded provider doesn't look wedged.
   */
  waiting: RetryNotice | null;
  /**
   * When the agent last said anything, once it's been quiet past the notice;
   * null while it's talking. The card reads the silence against its own clock,
   * so a stall shows as a stall.
   */
  quietSince: number | null;
  failedIds: readonly string[];
};

type ActiveRunnerState = Omit<RunnerState, "failedIds">;

function isStateUpdater(
  value: ActiveRunnerState | ((state: ActiveRunnerState) => ActiveRunnerState),
): value is (state: ActiveRunnerState) => ActiveRunnerState {
  return typeof value === "function";
}

export type RunnerChild = {
  /** Set for a process Leglas spawned; a transport's turn has none. */
  pid?: number | undefined;
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
  options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: boolean },
) => RunnerChild;

export type RunnerOptions = {
  cwd: string;
  externallyAttached: () => boolean;
  /** Called whenever the process-local state exposed by snapshot changes. */
  onChange?: () => void;
  spawn?: RunnerSpawn;
  /** Injected by app-server tests; null keeps the legacy Codex CLI path. */
  codexAppServer?: CodexTurnRunner | null;
  /** Injected by Agent SDK tests; null keeps the legacy Claude CLI path. */
  claudeAgentSession?: ClaudeTurnRunner | null;
  setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  /** Injected by tests so the cancel grace period does not cost real seconds. */
  setTimeout?: (callback: () => void, milliseconds: number) => void;
  /** Injected by tests so half an hour of silence does not cost half an hour. */
  now?: () => number;
  /**
   * How a fork's prompt names the registration CLI, as the prompt composer got
   * it. Feeds the pre-approval a non-interactive CLI needs to run it; absent,
   * no allowance is granted.
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
  images: readonly string[];
};

type ObservedTurn = { sessionId: string | null; edited: boolean; retry: RetryNotice | null };

type ChildOutcome = { ok: true; code: number } | { ok: false; error: string };

/**
 * How many requests share one vendor session before a fresh one. Each resumed
 * turn sends the whole conversation back, so an unbounded session makes each
 * request dearer; eight keeps the discount and caps the cost.
 */
const SESSION_TURNS_CAP = 8;

function resolveCommand(
  choice: SavedAgentChoice,
  prompt: string,
  sessionId: string | null = null,
  allowedCommands: readonly string[] = [],
  images: readonly string[] = [],
): ResolvedCommand | null {
  if (choice.agent === null) return null;

  // A custom template is the user's own command and permissions; nothing is
  // appended to it.
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
      images: [],
    };
  }

  const adapter = KNOWN_AGENTS[choice.agent];

  const allow =
    allowedCommands.length > 0 && "allowArgs" in adapter ? adapter.allowArgs(allowedCommands) : [];

  if (sessionId !== null && "resumeArgs" in adapter) {
    return {
      agent: choice.agent,
      name: adapter.name,
      command: adapter.binary,
      args: [...adapter.resumeArgs(sessionId, prompt, choice.effort, images), ...allow],
      prompt,
      effort: choice.effort,
      sessionId,
      resumed: true,
      images,
    };
  }

  return {
    agent: choice.agent,
    name: adapter.name,
    command: adapter.binary,
    args: [...adapter.args(prompt, choice.effort, images), ...allow],
    prompt,
    effort: choice.effort,
    sessionId: null,
    resumed: false,
    images,
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
  options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: boolean },
): RunnerChild {
  return nodeSpawn(command, args, { ...options, env: agentEnvironment() });
}

/**
 * Runs queued requests through the chosen local agent, one at a time. An
 * attached watcher goes first, since it already shows the agent's output in a
 * terminal and a second agent would edit the same tree.
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
              ? []
              : [`${options.leglasCommand} show`, registrationCommand(options.leglasCommand)],
          )
        : null
      : options.claudeAgentSession;

  const setEvery =
    options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));

  const clearEvery = options.clearInterval ?? ((handle) => clearInterval(handle));

  const failed = new Set<string>();

  const setLater =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number) => {
      // Unrefed, so a grace period counting down never keeps the process alive.
      setTimeout(callback, milliseconds).unref?.();
    });

  const now = options.now ?? (() => Date.now());

  let state: ActiveRunnerState = {
    running: false,
    requestId: null,
    agent: null,
    activity: null,
    startedAt: null,
    stopping: false,
    waiting: null,
    quietSince: null,
  };

  const setState = (
    next: ActiveRunnerState | ((current: ActiveRunnerState) => ActiveRunnerState),
  ): void => {
    state = isStateUpdater(next) ? next(state) : next;
    options.onChange?.();
  };

  let stopped = false;
  let ticking: Promise<void> | null = null;
  // Requests can land while the previous tick removes its finished entry.
  // Nudges are counted, not coalesced: each queued addition gets one immediate
  // successor tick, never overlapping the active agent.
  let pendingNudges = 0;
  let stopPromise: Promise<void> | null = null;

  let active: {
    child: RunnerChild | null;
    requestId: string;
    cancelled: boolean;
    controller: AbortController;
    /** Settle the run as stopped without waiting for the child's streams. */
    abandon: () => void;
    /** When the agent last produced a line of output, or started. */
    heardAt: number;
    /** True once Leglas has ended the run for saying nothing. */
    silenced: boolean;
    /** True when the child is a spawned process leading its own group, not a transport's turn. */
    spawned: boolean;
  } | null = null;

  /** Which vendor the run in flight is on, so a switch never tears it down. */
  let activeAgent: AgentChoice | null = null;
  /** The vendor last asked for, which is the one worth keeping warm. */
  let desiredAgent: AgentChoice | null = null;

  const transportFor = (agent: AgentChoice) =>
    agent === "codex" ? codexAppServer : agent === "claude" ? claudeAgentSession : null;

  /** Let go of every transport but one, never the one with a run in flight. */
  const releaseAllBut = (keep: AgentChoice | null) => {
    for (const other of ["codex", "claude"] as const) {
      if (other === keep) continue;

      if (active !== null && activeAgent === other) continue;
      void transportFor(other)
        ?.release()
        .catch(() => {});
    }
  };

  /**
   * Releases every transport after an idle spell. A generation counter, not a
   * cleared timer: the injected setTimeout returns nothing, and an unref'd real
   * one can fire and be ignored.
   */
  let idleGeneration = 0;

  const armIdleRelease = () => {
    if (stopped) return;
    const generation = ++idleGeneration;
    setLater(() => {
      if (generation !== idleGeneration || stopped) return;

      // A run in flight is what the process is for; check again later.
      if (active !== null) {
        armIdleRelease();

        return;
      }

      for (const transport of [codexAppServer, claudeAgentSession]) {
        void transport?.release().catch(() => {});
      }
    }, IDLE_RELEASE_MS);
  };

  /**
   * Warms one vendor and releases the other. Paid on intent (an agent chosen,
   * the composer focused), never at boot, since a saved choice isn't a request.
   * One transport at a time; a quick switch back costs a re-warm hidden behind
   * typing.
   */
  const prepare = (agent: AgentChoice): void => {
    if (stopped) return;
    desiredAgent = agent;
    releaseAllBut(agent);
    // Warmed for the conversation the next request continues, so a released
    // session is loaded again before Enter.
    void transportFor(agent)
      ?.warm(resumable(agent))
      .catch(() => {});
    armIdleRelease();
  };

  /**
   * The vendor session each agent may continue, in memory on purpose: one
   * outliving the process would be stale, and the vendor may have cleaned it
   * up. Dropped on any failure or cancel so a wedged conversation can't taint
   * later requests.
   */
  const sessions = new Map<AgentChoice, { id: string; turns: number }>();

  /** The session the next request on this vendor continues, if any. */
  const resumable = (agent: AgentChoice): string | null => {
    const session = sessions.get(agent);

    return session !== undefined && session.turns < SESSION_TURNS_CAP ? session.id : null;
  };

  const idle = () => {
    setState({
      running: false,
      requestId: null,
      agent: null,
      activity: null,
      startedAt: null,
      stopping: false,
      waiting: null,
      quietSince: null,
    });
  };

  const rememberLine = (lines: string[], line: string) => {
    lines.push(line);

    if (lines.length > OUTPUT_LINES) lines.splice(0, lines.length - OUTPUT_LINES);
  };

  /**
   * Writes the verdict where the interface and the next process can read it,
   * and puts the agent's last words in Leglas's terminal. The output stays
   * here: vendor logs can carry a prompt, a path or a token.
   */
  const reportFailure = async (
    request: PendingRequest,
    failure: Failure,
    lines: readonly string[],
  ): Promise<void> => {
    await markFailed(options.cwd, request.id, failure).catch(() => {
      // The queue is unwritable; the in-memory record still stops a rerun for
      // this process's life.
    });
    // The in-memory verdict must not show before the durable one: consumers
    // read failedIds as "the queue is ready".
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
    observed: ObservedTurn,
  ): Promise<ChildOutcome> => {
    const persistent =
      resolved.agent === "codex"
        ? codexAppServer
        : resolved.agent === "claude"
          ? claudeAgentSession
          : null;

    const controller = new AbortController();

    const current: NonNullable<typeof active> = {
      child: null,
      requestId: request.id,
      cancelled: false,
      controller,
      abandon: () => {},
      heardAt: now(),
      silenced: false,
      spawned: false,
    };

    // Cancellation must exist before an embedded transport starts. Warming,
    // thread creation and turn start all await vendor work before there's a
    // child to signal, which made Stop a no-op here.
    active = current;
    activeAgent = resolved.agent;

    const cancelled = (): ChildOutcome => ({ ok: false, error: "cancelled" });
    const silent = (): ChildOutcome => ({ ok: false, error: "silent" });

    // Any line on either stream means the agent is still there. State only
    // changes while a notice shows, so a chatty run costs nothing extra.
    const heard = () => {
      current.heardAt = now();

      if (active === current && state.quietSince !== null) {
        setState((value) => ({ ...value, quietSince: null }));
      }
    };

    const startPersistent = async (): Promise<RunnerChild> => {
      if (persistent === null) throw new Error("No persistent transport.");

      const starting = persistent.run(
        {
          prompt: resolved.prompt,
          effort: resolved.effort,
          sessionId: resolved.sessionId,
          images: resolved.images,
        },
        controller.signal,
      );

      return new Promise<RunnerChild>((resolve, reject) => {
        // A compliant transport rejects only after its startup cleanup ends.
        // The grace path tears down the process of one that ignores its abort,
        // so the queue never advances while a late process can still appear.
        // Released, not closed: closing it left every later run on the cold CLI
        // path.
        current.abandon = () => {
          void persistent
            .release()
            .catch(() => {})
            .then(() => reject(new Error("cancelled")));
        };

        void starting.then(
          (child) => {
            if (controller.signal.aborted) {
              try {
                child.kill("SIGKILL");
              } catch {
                // The transport already finished its own cancellation.
              }

              reject(new Error("cancelled"));

              return;
            }

            resolve(child);
          },
          (cause: unknown) => reject(cause),
        );
      });
    };

    // Its own process group, so a stop reaches whatever the agent started too.
    const spawnAgent = (): RunnerChild => {
      const child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...ownGroup(),
      });

      current.spawned = true;

      return child;
    };

    try {
      let child: RunnerChild;

      try {
        child = persistent !== null ? await startPersistent() : spawnAgent();
      } catch (error) {
        // A transport ended for silence must not fall back to the CLI behind
        // it, which would ask the same unanswered question.
        if (current.silenced) return silent();

        if (current.cancelled || stopped || controller.signal.aborted) return cancelled();

        // A missing SDK, older Codex or failed handshake keeps the plain vendor
        // CLI path.
        if (persistent !== null) {
          try {
            child = spawnAgent();
          } catch (fallbackError) {
            return {
              ok: false,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            };
          }
        } else {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      current.child = child;

      if (current.cancelled || stopped || controller.signal.aborted) {
        try {
          signalChild(current, "SIGTERM");
        } catch {
          // The run is already classified as cancelled below.
        }

        return current.silenced ? silent() : cancelled();
      }

      const stdoutFlush = lineReader(child.stdout, (line) => {
        heard();
        rememberLine(lines, line);
        const sessionId = sessionFrom(resolved.agent, line);

        if (sessionId !== null) observed.sessionId = sessionId;
        const retry = retryFrom(resolved.agent, line);

        if (retry !== null) {
          observed.retry = retry;

          if (active === current) setState((value) => ({ ...value, waiting: retry }));
        }

        const activity = activityFrom(resolved.agent, line, options.cwd);

        if (activity !== null) {
          if (activity.startsWith("editing")) observed.edited = true;

          // Any other output ends the wait.
          if (active === current) {
            setState((value) => ({ ...value, activity, waiting: null }));
          }
        }
      });

      const stderrFlush = lineReader(child.stderr, (line) => {
        heard();
        rememberLine(lines, line);
      });

      return await new Promise<ChildOutcome>((resolve) => {
        let settled = false;

        const settle = (outcome: ChildOutcome) => {
          if (settled) return;
          settled = true;
          stdoutFlush();
          stderrFlush();
          resolve(outcome);
        };

        current.abandon = () => settle(current.silenced ? silent() : cancelled());

        // An error on the way out, such as a signal Node couldn't deliver,
        // belongs to the ending Leglas chose. Only an unasked-for error is the
        // agent's own failure.
        child.once("error", (error) => {
          if (current.cancelled) return settle(cancelled());

          if (current.silenced) return settle(silent());
          settle({ ok: false, error: error.message });
        });
        child.once("close", (code, signal) => {
          if (current.cancelled) return settle(cancelled());

          if (current.silenced) return settle(silent());

          if (signal !== null) return settle({ ok: false, error: `stopped by ${signal}` });
          settle({ ok: true, code: code ?? 0 });
        });
      });
    } finally {
      if (active === current) active = null;
    }
  };

  /** The previews file as it stands, or null before it exists. */
  const registered = (): Promise<string | null> =>
    readFile(join(options.cwd, LOCAL_PREVIEWS_PATH), "utf8").catch(() => null);

  const handle = async (request: PendingRequest, choice: SavedAgentChoice): Promise<void> => {
    const allowedCommands =
      options.leglasCommand === undefined
        ? []
        : [
            `${options.leglasCommand} show`,
            ...(request.mode === "variant" ? [registrationCommand(options.leglasCommand)] : []),
          ];

    // The queue read already keeps attachments inside the request's directory
    // by name; this is the same fence with links resolved, where the path
    // leaves for a transport.
    const images = (
      await Promise.all(
        (request.attachments ?? []).map(async (attachment) =>
          (await isOwnCapture(options.cwd, attachment.file))
            ? resolve(options.cwd, attachment.file)
            : null,
        ),
      )
    ).filter((image): image is string => image !== null);

    let resolved = resolveCommand(
      choice,
      request.prompt,
      choice.agent === null ? null : resumable(choice.agent),
      allowedCommands,
      images,
    );

    if (resolved === null) return;

    const lines: string[] = [];

    try {
      // An external collector that won the race owns this request. The false
      // return is the queue file's lock.
      if (!(await markPickedUp(options.cwd, request.id))) return;

      // Stop may have landed during the queue write, before any child existed
      // to cancel. Record it as ended by the shutdown rather than start work or
      // leave it picked-up.
      if (stopped) {
        await reportFailure(
          request,
          classifyFailure({ agent: resolved.name, error: "stopped by shutdown" }),
          [],
        );

        return;
      }

      // Wall clock, not injected time: it only feeds the shell's elapsed
      // counter, which reads its own Date.now.
      setState({
        running: true,
        requestId: request.id,
        agent: resolved.name,
        activity: null,
        startedAt: Date.now(),
        stopping: false,
        waiting: null,
        quietSince: null,
      });

      const observed: ObservedTurn = {
        sessionId: null,
        edited: false,
        retry: null,
      };

      // A fork's one observable outcome is its previews entry, so exit 0 is
      // judged against the file as it was before the run.
      const before = request.mode === "variant" ? await registered() : null;
      // Read once: a cold rerun resolves the same vendor.
      const agent = resolved.name;
      let outcome = await runChild(request, resolved, lines, observed);

      const verdict = (): Failure =>
        classifyFailure({
          agent,
          error: outcome.ok
            ? null
            : stopped && outcome.error === "cancelled"
              ? "stopped by shutdown"
              : outcome.error,
          exitCode: outcome.ok ? outcome.code : null,
          lines,
          retry: observed.retry,
        });

      let failure = verdict();

      // A resume that died without touching a file is a session problem (the
      // vendor may have cleaned it up), so one cold retry hides it. A resume
      // that edited and failed isn't retried, since rerunning could stack
      // half-applied changes. The edited flag relies on activityFrom labelling
      // every edit; an event without path data slips past, which is accepted.
      //
      // The verdict gates it too: an overloaded provider, a spent limit, a
      // signed-out CLI or a refused directory answers the second run the same
      // way. Claude alone retries an overload ten times over about 200 seconds.
      if (
        !(outcome.ok && outcome.code === 0) &&
        resolved.resumed &&
        !observed.edited &&
        // The edited flag is evidence only where Leglas has read the vendor's
        // real output; elsewhere "didn't edit" means "wasn't seen to edit".
        // Those vendors keep the failure card and its Retry.
        activityVerified(resolved.agent) &&
        conversationFailure(failure.code) &&
        // Not redundant: a stop between the first child settling and the retry
        // starting finds no child to cancel.
        !stopped
      ) {
        sessions.delete(resolved.agent);
        const cold = resolveCommand(choice, request.prompt, null, allowedCommands, images);

        if (cold !== null) {
          resolved = cold;
          observed.sessionId = null;
          observed.retry = null;
          // The failed attempt's activity must not caption the fresh one.
          setState((value) => ({ ...value, activity: null, waiting: null }));
          outcome = await runChild(request, resolved, lines, observed);
          failure = verdict();
        }
      }

      if (outcome.ok && outcome.code === 0) {
        // An exit 0 that registered nothing didn't finish its last step.
        // Counting it as success made three runs vanish: request removed, card
        // gone, rail unchanged. The conversation ignored its final instruction,
        // so it isn't resumed either.
        if (request.mode === "variant" && (await registered()) === before) {
          sessions.delete(resolved.agent);
          await reportFailure(request, classifyFailure({ agent, error: "not-registered" }), lines);

          return;
        }

        if (observed.sessionId !== null) {
          const previous = sessions.get(resolved.agent);
          sessions.set(resolved.agent, {
            id: observed.sessionId,
            turns: resolved.resumed && previous?.id === observed.sessionId ? previous.turns + 1 : 1,
          });
        }

        // A change in place answered its notes by rewriting the design they
        // pin, so the notes go. A fork leaves them; their direction is
        // unchanged.
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
      activeAgent = null;
      // A switch during the run kept this vendor alive for it. Now only the
      // vendor last asked for stays warm, or the one that just ran.
      releaseAllBut(desiredAgent ?? choice.agent);
      // The run is the last thing that used the transport; its clock starts now.
      armIdleRelease();
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

  /**
   * A spawned process is signalled with everything it started; a transport's
   * turn has no process, so its kill is an interrupt.
   */
  const signalChild = (current: NonNullable<typeof active>, value: NodeJS.Signals): void => {
    const { child } = current;

    if (child === null) return;

    if (current.spawned) signalTree(child, value);
    else child.kill(value);
  };

  /** Asks the run in flight to stop, and makes sure it's gone once the grace period is up. */
  const end = (current: NonNullable<typeof active>): void => {
    current.controller.abort();

    try {
      signalChild(current, "SIGTERM");
    } catch {
      // The close or error event still settles the run if the process raced us.
    }

    setLater(() => {
      // Already settled: the child went and this slot belongs to another run.
      if (active !== current) return;

      try {
        signalChild(current, "SIGKILL");
      } catch {
        // Nothing left to signal; the run is settled below either way.
      }

      current.abandon();
    }, CANCEL_GRACE_MS);
  };

  /**
   * Checks the run in flight once a poll. Past the notice the card learns when
   * the agent last spoke; past the ceiling the run ends like a stop, under its
   * own verdict. Any output resets both.
   */
  const listen = (): void => {
    const current = active;

    if (current === null || current.cancelled || current.silenced) return;
    const quiet = now() - current.heardAt;

    if (quiet >= SILENCE_CEILING_MS) {
      current.silenced = true;
      setState((value) => ({ ...value, stopping: true, waiting: null, quietSince: null }));
      end(current);

      return;
    }

    if (quiet >= QUIET_NOTICE_MS && state.quietSince === null) {
      setState((value) => ({ ...value, quietSince: current.heardAt }));
    }
  };

  const timer = setEvery(() => {
    listen();
    schedule();
  }, POLL_MS);

  schedule();

  const cancel = (id?: string): boolean => {
    // A run already ending for silence keeps that verdict.
    if (active === null || active.cancelled || active.silenced) return false;

    // A stop for a specific request must not hit its successor: between runs,
    // the card clicked may describe a run that no longer exists.
    if (id !== undefined && active.requestId !== id) return false;
    const current = active;
    current.cancelled = true;
    failed.add(current.requestId);
    // The card stops claiming the run is live as soon as the stop is asked for.
    setState((value) => ({ ...value, stopping: true, waiting: null, quietSince: null }));
    end(current);

    return true;
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    clearEvery(timer);
    cancel();
    stopPromise = Promise.resolve(ticking)
      .catch(() => {})
      .then(() => Promise.all([codexAppServer?.close(), claudeAgentSession?.close()]))
      .then(() => {});

    return stopPromise;
  };

  return {
    stop,
    snapshot: () => ({ ...state, failedIds: [...failed] }),
    cancel,
    prepare,
    // A nudge during a tick is latched until the tick settles; between ticks it
    // starts one at once. Neither overlaps the active agent.
    nudge: () => schedule(true),
  };
}
