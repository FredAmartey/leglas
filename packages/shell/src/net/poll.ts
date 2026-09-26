/**
 * A repeating background read that can't outrun itself. A bare `setInterval`
 * around `fetch` enqueues a read every tick whether or not the last came back.
 * Chrome allows six HTTP/1.1 sockets per origin, and the shell, the API and
 * every preview iframe share one origin, so seven previews spend the budget
 * alone. Reads then pile up faster than they drain, and a user's POST waits
 * behind them; clicking Delete once appeared to hang for over ten minutes with
 * the server answering in milliseconds.
 *
 * Two rules, kept here so no poll can forget them:
 *
 * - One read at a time. A tick during a read is dropped, not queued, so a loop
 *   never holds more than one socket. A loop reading several endpoints reads
 *   them in turn.
 * - Every read has a deadline, after which it's aborted and its socket
 *   returned.
 */

import type { TimerHandle } from "./timers.js";

/** One read. What it resolves with is its own business; the loop only waits for it. */
export type PollTask = (signal: AbortSignal) => Promise<void>;

/**
 * Whether a read ended because this module abandoned it. The browser's wording
 * for our abort ("signal is aborted without reason") describes a deadline no
 * caller knows about, so a caller showing failures must tell it apart from what
 * the server said.
 */
export function wasAborted(error: unknown): error is Error & { name: "AbortError" } {
  return error instanceof Error && error.name === "AbortError";
}

/** Injected so tests can run an hour of polling instantly. */
export type PollTimers = {
  setInterval: (callback: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type PollOptions = {
  everyMs: number;
  /**
   * Something other than the clock meaning "read now": a server nudge, run
   * through the same `run` as a tick, so it's dropped mid-read and gets the
   * same deadline. The caller wires it to the live socket and returns the
   * unsubscribe.
   *
   * The interval stays as a slow fallback, so a dropped socket makes the
   * interface slower to notice rather than blind: polling heals on the next
   * tick, while a quietly dead socket leaves a rail that looks right and never
   * updates.
   */
  subscribe?: (run: () => void) => () => void;
  /**
   * How long one read may take before it's abandoned. A backstop, not a latency
   * target: far longer than any honest response, short enough that a socket
   * lost to a wedged request comes back within the minute.
   */
  timeoutMs?: number;
  timers?: PollTimers;
};

export const POLL_TIMEOUT_MS = 10_000;

const realTimers: PollTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

type Run = { controller: AbortController; deadline: TimerHandle };

/**
 * Starts reading now and keeps reading; returns the stop, which clears the
 * interval and aborts what's in flight.
 */
export function startPoll(task: PollTask, options: PollOptions): () => void {
  const { everyMs, timeoutMs = POLL_TIMEOUT_MS, timers = realTimers } = options;

  let stopped = false;
  let active: Run | null = null;

  const run = () => {
    // The whole guard: a tick mid-read is dropped.
    if (stopped || active !== null) return;

    const controller = new AbortController();

    const deadline = timers.setTimeout(() => {
      controller.abort();

      // Clearing the slot as well as aborting matters for a task that ignores
      // its signal, or the loop stays shut for the page's life.
      if (active?.controller === controller) active = null;
    }, timeoutMs);

    const current: Run = { controller, deadline };
    active = current;

    // A later read may have started if this one missed its deadline, so
    // settling clears only the slot it still owns.
    const settle = () => {
      if (active !== current) return;
      timers.clearTimeout(deadline);
      active = null;
    };

    void task(controller.signal).then(settle, settle);
  };

  run();
  const timer = timers.setInterval(run, everyMs);
  // After the first read, so a nudge during it is dropped by the guard.
  const unsubscribe = options.subscribe?.(run);

  return () => {
    stopped = true;
    unsubscribe?.();
    timers.clearInterval(timer);

    if (active === null) return;
    timers.clearTimeout(active.deadline);
    active.controller.abort();
    active = null;
  };
}
