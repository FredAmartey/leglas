export type RequestStatus = {
  id: string;
  title: string;
  status: "queued" | "picked-up" | "running" | "failed";
};

export type AgentStatus = {
  attached: boolean;
  running: boolean;
  name: string | null;
  activity: string | null;
  startedAt: number | null;
};

export type AgentOption = {
  id: string;
  name: string;
  available: boolean;
  /** The CLI's own answer about its login; unknown never blocks anything. */
  auth: "ok" | "signed-out" | "unknown";
};

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
  | { kind: "manual" }
  | { kind: "choose" }
  | { kind: "none" };

export function composerAgent(
  choice: string | null,
  available: readonly AgentOption[],
  dismissed: boolean,
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
  return dismissed ? { kind: "manual" } : { kind: "choose" };
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
    }
  | { kind: "queued"; count: number; attended: boolean }
  | { kind: "picked-up" }
  | { kind: "failed"; id: string; title: string };

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
    };
  }

  const queued = requests.filter((request) => request.status === "queued").length;
  if (queued > 0) return { kind: "queued", count: queued, attended };

  if (requests.some((request) => request.status === "picked-up")) return { kind: "picked-up" };

  const failed = requests.findLast((request) => request.status === "failed");
  if (failed !== undefined) return { kind: "failed", id: failed.id, title: failed.title };

  return null;
}
