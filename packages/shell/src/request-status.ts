/** Why a request ended, as the server classified it. */
export type RequestFailure = { code: string; message: string };

export type RequestStatus = {
  id: string;
  title: string;
  /**
   * "running" is the server's overlay for the one request in flight; the
   * other four are the queue's own. "cancelled" is separate from "failed" on
   * purpose: the same card treated a stop and a provider outage alike, and
   * offering to run the thing the user just stopped is the one reaction that
   * is always wrong.
   */
  status: "queued" | "picked-up" | "running" | "failed" | "cancelled";
  /**
   * A variant is built beside the direction it was asked of and leaves it
   * alone; a replace rewrites it. Absent on a payload from an older server,
   * which is read as a replace, the cautious answer.
   */
  mode?: "variant" | "replace";
  failure?: RequestFailure | null;
};

/**
 * The vendor's own backoff, while a run is inside one.
 *
 * Claude reports each attempt as it retries; nothing else reaches the
 * interface during that time, which is how a 200-second wait on an overloaded
 * provider came to look like an agent quietly thinking.
 */
export type AgentWaiting = {
  attempt: number;
  max: number | null;
  status: number | null;
  reason: string | null;
};

export type AgentStatus = {
  attached: boolean;
  running: boolean;
  name: string | null;
  activity: string | null;
  startedAt: number | null;
  /** A stop has been asked for and the agent has not gone yet. */
  stopping?: boolean;
  waiting?: AgentWaiting | null;
};

export type AgentOption = {
  id: string;
  name: string;
  available: boolean;
  /** The CLI's own answer about its login; unknown never blocks anything. */
  auth: "ok" | "signed-out" | "unknown";
  /** Levels this CLI has a verified non-interactive flag for. */
  efforts: readonly AgentEffort[];
};

/**
 * Directions whose source may change before their current request settles.
 *
 * A fork is not one of them: the agent is told to leave the parent exactly as
 * it is and build beside it. Counting the parent here forgot its duplicate
 * verdict and read the page again after every fork, the default request.
 */
export function changingRequestTitles(requests: readonly RequestStatus[]): string[] {
  return [
    ...new Set(
      requests
        .filter(
          (request) =>
            request.mode !== "variant" &&
            (request.status === "queued" ||
              request.status === "picked-up" ||
              request.status === "running"),
        )
        .map((request) => request.title),
    ),
  ];
}

/** Directions an agent has actually picked up, excluding work still queued. */
export function workingRequestTitles(requests: readonly RequestStatus[]): Set<string> {
  return new Set(
    requests
      .filter((request) => request.status === "picked-up" || request.status === "running")
      .map((request) => request.title),
  );
}

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What the chip in the composer says: who Enter sends to.
 *
 * This used to share one slot with the run status, which meant a running
 * request hid the chooser and switching agents mid-queue was impossible. The
 * chip is now permanent composer furniture, so its state depends only on the
 * choice, never on the queue.
 */
export type ComposerAgent =
  | { kind: "chosen"; id: string; name: string }
  | { kind: "choose" }
  | { kind: "none" };

export function composerAgent(
  choice: string | null,
  available: readonly AgentOption[],
  customRun: string | null = null,
): ComposerAgent {
  if (choice === "custom") {
    // The chip wears the command's own name: "aider" says more than
    // "Custom" ever will, and the command's first word is its name.
    const word = customRun?.trim().split(/\s+/)[0] ?? "";
    const name = word === "" ? "Custom" : (word.split("/").pop() ?? "Custom");
    return { kind: "chosen", id: "custom", name };
  }

  const selected = choice === null ? undefined : available.find((option) => option.id === choice);
  // A chosen binary that has left the PATH cannot run anything, so the chip
  // must not keep wearing its name.
  if (selected?.available) return { kind: "chosen", id: selected.id, name: selected.name };

  if (!available.some((option) => option.available)) return { kind: "none" };
  return { kind: "choose" };
}

/**
 * The card above the composer: what is happening to requests right now.
 *
 * One card, highest event wins. A failure keeps until the queue is busy with
 * something newer, then resurfaces once things calm down, which mirrors how
 * the queue itself treats failed requests: parked, never blocking.
 */
export type RequestCard =
  | {
      kind: "running";
      /** Which request the stop button means; null while only the agent poll
       * knows about the run, in which case a stop falls back to "the active
       * one". */
      id: string | null;
      name: string;
      activity: string | null;
      startedAt: number | null;
      title: string | null;
      /** True once a stop is asked for, until the agent actually goes. */
      stopping: boolean;
      /** Set while the vendor is backing off, so the wait can say why. */
      waiting: AgentWaiting | null;
    }
  | { kind: "queued"; count: number; attended: boolean }
  | { kind: "picked-up" }
  | { kind: "failed"; id: string; title: string; reason: string | null }
  | { kind: "stopped"; id: string; title: string };

/**
 * What a run is waiting on, in one short line under the agent's name.
 *
 * Leglas cannot shorten a vendor's backoff and must not kill a run to escape
 * it: the same process may be mid-edit, and the attempt after this one may be
 * the one that works. What it can do is stop the wait being unexplained, so
 * the stop button becomes a decision instead of a guess.
 */
export function waitingLabel(waiting: AgentWaiting): string {
  const of =
    waiting.max === null
      ? `retry ${waiting.attempt}`
      : `retry ${waiting.attempt} of ${waiting.max}`;
  const status = waiting.status;
  const reason = waiting.reason ?? "";
  if (status === 429 || reason.includes("rate")) return `provider is rate limiting · ${of}`;
  if (status === 401 || status === 403 || reason.includes("auth"))
    return `provider refused the login · ${of}`;
  if (status === 529 || status === 503 || reason.includes("overload"))
    return `provider is overloaded · ${of}`;
  return `provider returned an error · ${of}`;
}

/**
 * Seconds under a minute, then whole minutes with seconds. Runs are minutes
 * long at most, so hours would be dressing the format up for a case the
 * cancel button exists to prevent.
 */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function requestCard(
  requests: readonly RequestStatus[],
  agent: AgentStatus,
  attended: boolean,
): RequestCard | null {
  const running = requests.find((request) => request.status === "running");
  if (agent.running || running !== undefined) {
    return {
      kind: "running",
      id: running?.id ?? null,
      name: agent.name ?? "Your agent",
      activity: agent.activity,
      startedAt: agent.startedAt,
      title: running?.title ?? null,
      stopping: agent.stopping === true,
      // A run on its way out is not waiting on a provider any more.
      waiting: agent.stopping === true ? null : (agent.waiting ?? null),
    };
  }

  const queued = requests.filter((request) => request.status === "queued").length;
  if (queued > 0) return { kind: "queued", count: queued, attended };

  if (requests.some((request) => request.status === "picked-up")) return { kind: "picked-up" };

  const ended = requests.findLast(
    (request) => request.status === "failed" || request.status === "cancelled",
  );
  if (ended === undefined) return null;
  if (ended.status === "cancelled") return { kind: "stopped", id: ended.id, title: ended.title };
  return {
    kind: "failed",
    id: ended.id,
    title: ended.title,
    // The server writes this line; the raw agent output stays in its terminal.
    reason: ended.failure?.message ?? null,
  };
}
