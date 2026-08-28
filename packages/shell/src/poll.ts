/**
 * A repeating background read that cannot outrun itself.
 *
 * Every live surface in the shell polls: the config for directions an agent
 * registered, the queue for what a run is doing, health for whether the dev
 * server still answers. Written as a bare `setInterval` around a `fetch`,
 * each of those enqueues a read on the tick whether or not the last one ever
 * came back, and that is fine right up until the browser has no socket to
 * give. Chrome allows six per origin over HTTP/1.1, and Leglas is a single
 * origin: the shell, the API, and every preview iframe proxying the user's
 * app all share the one budget. Load a project with seven previews and the
 * budget is spent on iframes alone.
 *
 * From there it compounds. The reads queue, the intervals keep firing, and
 * the queue grows faster than it drains, so a POST the user just made sits
 * behind a pile of polls that is longer every second. Nothing is broken and
 * nothing reports an error. The server answers every request in single-digit
 * milliseconds while the page sits there, and clicking Delete or switching
 * agent appears to hang for as long as it takes the pile to clear, which was
 * measured at over ten minutes.
 *
 * Two rules fix it, and both live here rather than at each call site so no
 * future poll can forget them:
 *
 * - One read at a time. A tick arriving while a read is in flight is
 *   dropped, not queued, which caps a loop at a single socket no matter how
 *   slow the answer is. Three loops then cost three of the six sockets
 *   instead of an unbounded number. A loop that reads more than one endpoint
 *   holds to this by reading them one after another, not at once.
 * - Every read has a deadline. A request that hangs past it is aborted, which
 *   returns the socket rather than holding it for the life of the page.
 */

export type PollTask = (signal: AbortSignal) => Promise<unknown>;

/**
 * Whether a read ended because this module abandoned it.
 *
 * The abort is our own doing, so the browser's wording for it ("signal is
 * aborted without reason") describes a deadline nobody outside this file
 * knows exists. A caller that puts failures on screen has to tell that apart
 * from something the server actually said, or it quotes our plumbing at the
 * user.
 */
export function wasAborted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Injected so tests can run an hour of polling instantly. Handles stay
 * `unknown` because the browser hands back numbers and Node hands back
 * objects, and this needs to hold either without caring.
 */
export type PollTimers = {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type PollOptions = {
  everyMs: number;
  /**
   * Something other than the clock that means "read now".
   *
   * The server pushes a nudge when it knows something changed, and this is
   * how that reaches a loop without letting it out of the two rules above.
   * A nudge goes through the same `run` an interval tick does, so it is
   * dropped when a read is already in flight and it gets the same deadline.
   * A caller wires this to the live socket and gets back the unsubscribe,
   * which the stop below calls.
   *
   * The interval stays. It is the fallback, and a slow one: a dropped socket
   * then means the interface is slower to notice a change rather than blind
   * to it, which is the difference between degrading and lying. Polling
   * fails invisibly and heals itself on the next tick; a socket that died
   * quietly leaves a rail that looks perfectly correct and never updates
   * again.
   */
  subscribe?: (run: () => void) => () => void;
  /**
   * How long one read may take before it is abandoned. This is a backstop,
   * not a latency target: it wants to be far longer than any honest response
   * so a slow dev server is never cut off, and short enough that a socket
   * lost to a wedged request comes back the same minute.
   */
  timeoutMs?: number;
  timers?: PollTimers;
};

export const POLL_TIMEOUT_MS = 10_000;

const realTimers: PollTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as never),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
};

type Run = { controller: AbortController; deadline: unknown };

/**
 * Start reading now and keep reading, returning the stop. The stop clears the
 * interval and aborts whatever is still in flight, so a torn-down effect
 * leaves no request behind to land on a component that is gone.
 */
export function startPoll(task: PollTask, options: PollOptions): () => void {
  const { everyMs, timeoutMs = POLL_TIMEOUT_MS, timers = realTimers } = options;

  let stopped = false;
  let active: Run | null = null;

  const run = () => {
    // The whole guard: a tick that arrives mid-read is dropped on the floor.
    if (stopped || active !== null) return;

    const controller = new AbortController();
    const deadline = timers.setTimeout(() => {
      controller.abort();
      // Clearing the slot as well as aborting matters for a task that does
      // not honour its signal: the abort alone would free the socket and
      // still leave this loop shut for the life of the page.
      if (active?.controller === controller) active = null;
    }, timeoutMs);
    const current: Run = { controller, deadline };
    active = current;

    // A later read may already have started if this one blew its deadline,
    // so settling only clears the slot it still owns.
    const settle = () => {
      if (active !== current) return;
      timers.clearTimeout(deadline);
      active = null;
    };
    void task(controller.signal).then(settle, settle);
  };

  run();
  const timer = timers.setInterval(run, everyMs);
  // After the first read, so a nudge arriving during it is dropped by the
  // guard rather than queueing a second one behind it.
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
