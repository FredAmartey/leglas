/** Why a request ended, as the server classified it. */
export type RequestFailure = { code: string; message: string };

export type RequestStatus = {
  id: string;
  title: string;
  /** The notes this change answers, by id. Empty when it was typed alone. */
  notes?: readonly string[];
  /**
   * "running" is the server's overlay for the one request in flight; the rest
   * are the queue's own. "cancelled" is separate from "failed" because offering
   * to rerun what the user just stopped is always wrong.
   */
  status: "queued" | "picked-up" | "running" | "failed" | "cancelled";
  /**
   * A variant is built beside the direction it was asked of; a replace rewrites
   * it. Absent from an older server, and read as replace, the cautious answer.
   */
  mode?: "variant" | "replace";
  failure?: RequestFailure | null;
};

/**
 * The vendor's own backoff while a run is in one. Claude reports each retry
 * attempt; nothing else reaches the interface then, so a 200-second wait on an
 * overloaded provider looked like the agent thinking.
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
  /** When a quiet run last said anything; null while it talks, absent from an older server. */
  quietSince?: number | null;
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
 * Directions whose source may change before their current request settles. Not
 * a fork's parent, which the agent leaves alone; counting it dropped its
 * duplicate verdict after every fork.
 */
export function changingRequestTitles(requests: readonly RequestStatus[]): string[] {
  return [
    ...new Set(
      requests.flatMap((request) =>
        request.mode !== "variant" &&
        (request.status === "queued" ||
          request.status === "picked-up" ||
          request.status === "running")
          ? [request.title]
          : [],
      ),
    ),
  ];
}

/**
 * Notes already inside an unfinished change. A request freezes its prompt when
 * sent, so rewording such a note afterwards is about the next change, and the
 * interface has to show that: a sent pin and an unread one looked alike. Failed
 * and cancelled requests are left out, since their notes are waiting to be sent
 * again.
 */
export function notesAwaitingChange(requests: readonly RequestStatus[]): Set<string> {
  return new Set(
    requests
      .filter(
        (request) =>
          request.status === "queued" ||
          request.status === "picked-up" ||
          request.status === "running",
      )
      .flatMap((request) => request.notes ?? []),
  );
}

/** Directions an agent has actually picked up, excluding work still queued. */
export function workingRequestTitles(requests: readonly RequestStatus[]): Set<string> {
  return new Set(
    requests.flatMap((request) =>
      request.status === "picked-up" || request.status === "running" ? [request.title] : [],
    ),
  );
}

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What the composer chip says: who Enter sends to. It used to share a slot with
 * the run status, so a running request hid the chooser; now it depends only on
 * the choice.
 */
export type ComposerAgent =
  { kind: "chosen"; id: string; name: string } | { kind: "choose" } | { kind: "none" };

export function composerAgent(
  choice: string | null,
  available: readonly AgentOption[],
  customRun: string | null = null,
): ComposerAgent {
  if (choice === "custom") {
    // The chip wears the command's own name: "aider" says more than "Custom".
    const word = customRun?.trim().split(/\s+/)[0] ?? "";
    const name = word === "" ? "Custom" : (word.split("/").pop() ?? "Custom");

    return { kind: "chosen", id: "custom", name };
  }

  const selected = choice === null ? undefined : available.find((option) => option.id === choice);

  // A chosen binary that left the PATH can't run anything, so the chip drops
  // its name.
  if (selected?.available) return { kind: "chosen", id: selected.id, name: selected.name };

  if (!available.some((option) => option.available)) return { kind: "none" };

  return { kind: "choose" };
}

/**
 * The card above the composer, highest event wins. A failure stays until
 * something newer happens, then comes back once things calm down, as the queue
 * parks failed requests without blocking.
 */
export type RequestCard =
  | {
      kind: "running";
      /**
       * Which request stop means; null while only the agent poll knows the run,
       * when stop falls back to the active one.
       */
      id: string | null;
      name: string;
      activity: string | null;
      startedAt: number | null;
      title: string | null;
      /** True once a stop is asked for, until the agent actually goes. */
      stopping: boolean;
      /** Set while the vendor is backing off, so the wait can say why. */
      waiting: AgentWaiting | null;
      /** When the agent last said anything, once it has gone quiet. */
      quietSince: number | null;
    }
  | { kind: "queued"; count: number; attended: boolean }
  | { kind: "picked-up" }
  | { kind: "failed"; id: string; title: string; reason: string | null }
  | { kind: "stopped"; id: string; title: string };

/**
 * What a run is waiting on, in one line under the agent's name. Leglas can't
 * shorten a vendor's backoff and mustn't kill a run to escape it (it may be
 * mid-edit, and the next attempt may work), but it can explain the wait so
 * stopping is a decision.
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
 * The card's two lines, computed here instead of nested ternaries in markup.
 * The headline says what happened; the detail is the one useful thing about it,
 * for a failure the server's verdict, never the agent's raw output.
 */
export function cardHeadline(card: RequestCard): string {
  return card.kind === "running"
    ? card.stopping
      ? `Stopping ${card.name}`
      : `${card.name} is on it`
    : card.kind === "queued"
      ? card.count === 1
        ? "Change queued"
        : `${card.count} changes queued`
      : card.kind === "picked-up"
        ? "Your agent is on it"
        : card.kind === "stopped"
          ? "You stopped that change"
          : "That change failed";
}

/**
 * The card's second line, against the card's clock where time matters. A quiet
 * run shows how long it's been quiet, since a stalled agent used to keep
 * reading "editing hero.tsx". A vendor retry outranks the silence as a better
 * explanation.
 */
export function cardDetail(card: RequestCard, now: number | null = null): string | null {
  return card.kind === "running"
    ? card.stopping
      ? "waiting for it to exit"
      : card.waiting !== null
        ? waitingLabel(card.waiting)
        : card.quietSince !== null && now !== null
          ? `no output for ${formatElapsed(now - card.quietSince)}`
          : (card.activity ?? card.title)
    : card.kind === "queued"
      ? card.attended
        ? "your agent picks it up next"
        : "pick who runs your changes"
      : card.kind === "failed"
        ? (card.reason ?? card.title)
        : card.kind === "stopped"
          ? card.title
          : null;
}

/** Seconds under a minute, then minutes and seconds. Runs are minutes long at most. */
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
      // A run on its way out isn't waiting or quiet; it's stopping.
      waiting: agent.stopping === true ? null : (agent.waiting ?? null),
      quietSince: agent.stopping === true ? null : (agent.quietSince ?? null),
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
