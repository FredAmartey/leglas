import { describe, expect, test, vi } from "vitest";

import { SHUTDOWN_SIGNALS, installShutdown, type ShutdownSignal } from "./shutdown.js";

function target() {
  const listeners = new Map<ShutdownSignal, (() => void)[]>();

  return {
    on(signal: ShutdownSignal, listener: () => void) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);

      return this;
    },
    signals: () => [...listeners.keys()],
    fire: (signal: ShutdownSignal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

describe("installShutdown", () => {
  test("handles every signal a terminal routinely sends, SIGHUP included", () => {
    // SIGHUP is what closing the terminal sends. Unhandled, Node exits without
    // the shutdown and orphans the capture browser.
    const listening = target();
    installShutdown(async () => {}, listening);

    expect(listening.signals()).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(SHUTDOWN_SIGNALS).toContain("SIGHUP");
  });

  test.each(SHUTDOWN_SIGNALS)("%s releases what Leglas is holding", (signal) => {
    const stop = vi.fn(async () => {});
    const listening = target();
    installShutdown(stop, listening);

    listening.fire(signal);

    expect(stop).toHaveBeenCalledOnce();
  });

  test("a second signal does not start a second shutdown", async () => {
    // A second Ctrl-C, or SIGHUP chasing SIGTERM as the terminal tears down.
    // Stopping twice would close a browser mid-close.
    const stop = vi.fn(async () => {});
    const listening = target();
    const shutdown = installShutdown(stop, listening);

    listening.fire("SIGINT");
    listening.fire("SIGHUP");
    await shutdown();

    expect(stop).toHaveBeenCalledOnce();
  });
});
