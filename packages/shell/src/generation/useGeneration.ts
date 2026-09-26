import { useCallback, useEffect, useState } from "react";

import { FALLBACK_MS, liveConnection } from "../net/live.js";
import { startPoll } from "../net/poll.js";
import { readGenerations } from "./generation-api.js";
import { isRunning, type GenerationJob } from "./generation.js";

/**
 * How long the read waits with no set running. A set started from the CLI
 * nudges anyway; this is the backstop.
 */
export const IDLE_GENERATION_MS = 60_000;

const NONE: readonly GenerationJob[] = [];

/**
 * The sets Leglas is building or built, kept current by the server's
 * `generation` nudge on every step. Off for share viewers, who can't read the
 * endpoint, and while the feature is off.
 */
export type Generations = {
  jobs: readonly GenerationJob[];
  /** A job this shell just started, shown before the next read brings it. */
  noteJob: (job: GenerationJob) => void;
};

export function useGeneration(enabled: boolean): Generations {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const running = jobs.some(isRunning);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const stop = startPoll(
      (signal) =>
        readGenerations(signal)
          .then((next) => {
            if (cancelled) return;
            setJobs((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next,
            );
          })
          .catch(() => {
            // A missed read is the fallback's problem; the last state stands.
          }),
      {
        everyMs: running ? FALLBACK_MS : IDLE_GENERATION_MS,
        subscribe: (run) => liveConnection().on("generation", run),
      },
    );

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, running]);

  const noteJob = useCallback((job: GenerationJob) => {
    setJobs((current) =>
      current.some((known) => known.id === job.id)
        ? current.map((known) => (known.id === job.id ? job : known))
        : [...current, job],
    );
  }, []);

  return { jobs: enabled ? jobs : NONE, noteJob };
}
