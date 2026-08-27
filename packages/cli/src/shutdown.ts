/**
 * The signals that mean "this Leglas is over", and what it owes on the way out.
 *
 * Leglas holds things the operating system will not tidy up for it: the dev
 * servers it started, the checkouts it made, and a headless browser for
 * captures. Only a handler can release those, so every signal a terminal
 * routinely sends has to have one.
 *
 * SIGHUP is the one that was missing, and it is the most ordinary of the
 * three: it arrives when the terminal window closes. Node's default action
 * for it is to terminate at once, so the shutdown never ran and the browser
 * was reparented to init, holding its memory until the machine restarted.
 * Invisibly, because it is headless.
 *
 * SIGKILL is deliberately absent. It cannot be handled by anyone, which is
 * why the browser also records who launched it, and a later Leglas closes the
 * ones whose owner is gone.
 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export type SignalTarget = {
  on(signal: ShutdownSignal, listener: () => void): unknown;
};

/**
 * Wire every shutdown signal to one stop, and run it at most once.
 *
 * Two signals in quick succession is ordinary: an impatient second Ctrl-C, or
 * a SIGHUP chasing a SIGTERM as a terminal tears down. Stopping twice would
 * close a browser mid-close and race the server's own teardown, so the second
 * one is ignored rather than queued.
 */
export function installShutdown(
  stop: () => Promise<void>,
  target: SignalTarget = process,
): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    stopping ??= stop();
    return stopping;
  };
  for (const signal of SHUTDOWN_SIGNALS) target.on(signal, () => void shutdown());
  return shutdown;
}
