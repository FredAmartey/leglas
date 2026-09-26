/**
 * The signals that end this Leglas. It holds dev servers, checkouts and a
 * headless capture browser that only a handler can release, so every signal a
 * terminal sends needs one. SIGHUP arrives when the terminal window closes, and
 * Node's default exits at once. SIGKILL can't be handled; the browser records
 * its owner so a later Leglas can close it.
 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export type SignalTarget = {
  on(signal: ShutdownSignal, listener: () => void): void;
};

/**
 * Wires every shutdown signal to one stop, run at most once. A second signal
 * soon after is ordinary, and stopping twice would close a browser mid-close.
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
