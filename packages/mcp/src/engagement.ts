import { DEFAULT_PORT, LEGLAS_PREFIX } from "leglas";

/**
 * Tells the server an agent is working the queue over MCP, so the embedded
 * runner yields as it does to leglas watch and doesn't grab a request
 * mid-change. Only queue activity counts, since a connected MCP server can sit
 * idle for hours. Touch starts the beat and a quiet spell lets it lapse.
 */

/** How often the server hears from an engaged session; matches watch. */
const BEAT_MS = 2000;

/** Queue work older than this no longer counts as engagement. */
const ENGAGEMENT_MS = 120_000;

/** A beat is worth a moment, never a stall. */
const POST_TIMEOUT_MS = 1000;

export type EngagementDeps = {
  post?: (watching: boolean) => Promise<void>;
  setInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  now?: () => number;
};

function defaultPost(watching: boolean): Promise<void> {
  // Best effort: every tool works without the server. LEGLAS_PORT covers a
  // server bound elsewhere.
  const port = Number(process.env.LEGLAS_PORT ?? "") || DEFAULT_PORT;

  return fetch(`http://localhost:${port}${LEGLAS_PREFIX}/api/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ watching }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  }).then(
    () => {},
    () => {},
  );
}

export type Engagement = {
  /**
   * Notes queue activity, starting or extending the beat. Settles once the
   * server has registered the engagement; await it before reading the queue,
   * since the runner backs off only after that. Watch does the same with its
   * first heartbeat.
   */
  touch(): Promise<void>;
  /** End the engagement and say so, as far as one best-effort post goes. */
  stop(): Promise<void>;
};

export function createEngagement(deps: EngagementDeps = {}): Engagement {
  const post = deps.post ?? defaultPost;

  const setEvery =
    deps.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));

  const clearEvery = deps.clearInterval ?? ((handle) => clearInterval(handle));

  const now = deps.now ?? (() => Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTouch = 0;

  const quiet = () => {
    if (timer === null) return;
    clearEvery(timer);
    timer = null;
  };

  const beat = () => {
    if (now() - lastTouch > ENGAGEMENT_MS) {
      quiet();
      void post(false);

      return;
    }

    void post(true);
  };

  return {
    touch() {
      lastTouch = now();

      // Mid-cycle the server already knows: nothing to wait for.
      if (timer !== null) return Promise.resolve();
      timer = setEvery(beat, BEAT_MS);

      return post(true).catch(() => {});
    },
    async stop() {
      const wasBeating = timer !== null;
      quiet();

      if (wasBeating) await post(false);
    },
  };
}
