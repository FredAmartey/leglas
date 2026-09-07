import type { spawn as spawnChild } from "node:child_process";

import type { RestartCommand } from "@leglas/server";

import { SHUTDOWN_SIGNALS, type ShutdownSignal, type SignalTarget } from "./shutdown.js";

export function createHandoff() {
  let transferred = false;

  /** Ordinary shutdown yields to the handoff as soon as it starts closing the server. */
  function handedOff(): boolean {
    return transferred;
  }

  async function handOff(
    command: RestartCommand,
    stop: () => Promise<void>,
    deps: {
      spawn: typeof spawnChild;
      exit: (code: number) => void;
      target: SignalTarget & { off(signal: ShutdownSignal, listener: () => void): unknown };
    },
  ): Promise<void> {
    transferred = true;
    let child: ReturnType<typeof spawnChild> | null = null;
    let cancelled = false;
    let exited = false;
    const listeners = SHUTDOWN_SIGNALS.map((signal) => {
      const listener = (): void => {
        if (child === null) cancelled = true;
        else child.kill(signal);
      };
      deps.target.on(signal, listener);
      return { signal, listener };
    });
    const cleanup = (): void => {
      for (const { signal, listener } of listeners) deps.target.off(signal, listener);
    };
    const exit = (code: number): void => {
      if (exited) return;
      exited = true;
      cleanup();
      deps.exit(code);
    };

    try {
      await stop();
    } catch (error) {
      if (cancelled) return exit(0);
      cleanup();
      transferred = false;
      throw error;
    }
    if (cancelled) return exit(0);

    const failed = (error: unknown): void => {
      if (exited) return;
      const message = (error instanceof Error ? error.message : String(error)).replace(/[.!?]+$/, "");
      process.stderr.write(`Could not start Leglas again: ${message}. Start it from your terminal.\n`);
      exit(1);
    };
    try {
      child = deps.spawn(command.file, command.args, { stdio: "inherit", shell: command.shell });
      child.once("error", failed);
      child.once("exit", (code: number | null) => exit(code ?? 1));
    } catch (error) {
      failed(error);
    }
  }

  return { handOff, handedOff };
}
