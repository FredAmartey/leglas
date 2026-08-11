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
};

export type AgentOption = {
  id: string;
  name: string;
  available: boolean;
};

export type RequestStatusDecision =
  | { kind: "picker" }
  | { kind: "ready"; name: string }
  | { kind: "status"; text: string; cancellable: boolean; failedId: string | null }
  | { kind: "hint" };

/**
 * Decide the whole composer footer from one polled snapshot.
 *
 * The states compete for one fixed slot, so their priority belongs here rather
 * than in conditional markup. That also keeps a picked-up request from hiding
 * a queued one and keeps an idle heartbeat from hiding either.
 */
export function requestStatusLine(
  requests: readonly RequestStatus[],
  agent: AgentStatus,
  choice: string | null,
  available: readonly AgentOption[],
  dismissed: boolean,
): RequestStatusDecision {
  if (agent.running || requests.some((request) => request.status === "running")) {
    const name = agent.name ?? "Your agent";
    return {
      kind: "status",
      text: agent.activity ? `${name} is on it: ${agent.activity}` : `${name} is on it`,
      cancellable: true,
      failedId: null,
    };
  }

  const queued = requests.filter((request) => request.status === "queued").length;
  if (queued > 0) {
    return {
      kind: "status",
      text: `${queued} change${queued === 1 ? "" : "s"} queued for your agent`,
      cancellable: false,
      failedId: null,
    };
  }

  if (requests.some((request) => request.status === "picked-up")) {
    return {
      kind: "status",
      text: "Your agent is on it",
      cancellable: false,
      failedId: null,
    };
  }

  const failed = requests.findLast((request) => request.status === "failed");
  if (failed !== undefined) {
    return {
      kind: "status",
      text: "That change failed. Try again?",
      cancellable: false,
      failedId: failed.id,
    };
  }

  if (agent.attached) {
    return {
      kind: "status",
      text: "Your agent is listening",
      cancellable: false,
      failedId: null,
    };
  }

  if (!available.some((option) => option.available)) return { kind: "hint" };

  if (choice !== null) {
    const selected = available.find((option) => option.id === choice);
    return {
      kind: "ready",
      name: selected?.name ?? (choice === "custom" ? "Custom" : choice),
    };
  }

  return dismissed ? { kind: "hint" } : { kind: "picker" };
}
