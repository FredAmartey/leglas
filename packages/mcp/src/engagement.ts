import { DEFAULT_PORT, LEGLAS_PREFIX } from "leglas";

/**
 * Tell the Leglas server an agent is working the queue over MCP.
 *
 * The embedded runner yields to an attached watcher, and an MCP host driving
 * the requests tool deserves the same right of way: without this, the runner
 * could grab a request that arrives while the host's agent is mid-change in
 * the same tree. Attachment is engagement, not connection: an MCP server sits
 * connected to its host for hours doing nothing, so merely being alive proves
 * nothing. Touch marks real queue activity, the beat keeps the server's
 * window fresh, and a quiet spell lets it lapse.
 */

/** How often the server hears from an engaged session; matches watch. */
const BEAT_MS = 2000;

/** Queue work older than this no longer counts as engagement. */
const ENGAGEMENT_MS = 120_000;

/** A beat is worth a moment, never a stall. */
const POST_TIMEOUT_MS = 1000;

export type EngagementDeps = {
  post?: (watching: boolean) => Promise<void>;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
};

function defaultPost(watching: boolean): Promise<void> {
  // Best effort at the default port: the queue is a file and every tool works
  // without the server, so a beat that lands nowhere costs nothing. LEGLAS_PORT
  // covers the server that had to bind elsewhere.
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
  /** Note queue activity: starts the beat, or extends it. */
  touch(): void;
  /** End the engagement and say so, as far as one best-effort post goes. */
  stop(): Promise<void>;
};

export function createEngagement(deps: EngagementDeps = {}): Engagement {
  const post = deps.post ?? defaultPost;
  const setEvery =
    deps.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearEvery =
    deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const now = deps.now ?? (() => Date.now());

  let timer: unknown = null;
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
      if (timer !== null) return;
      timer = setEvery(beat, BEAT_MS);
      void post(true);
    },
    async stop() {
      const wasBeating = timer !== null;
      quiet();
      if (wasBeating) await post(false);
    },
  };
}
