/**
 * Why a run ended, in words the interface can show and code it can act on.
 *
 * A run that ends badly used to leave two things behind: a request parked in
 * the queue, and twenty lines of vendor output in the server's terminal. The
 * interface could only say "That change failed", which reads the same whether
 * the user stopped it themselves, the provider was down, or the CLI refused
 * to start at all. Those want different reactions, so the runner classifies
 * once and everything downstream reads the verdict instead of guessing.
 *
 * The codes are Leglas's own, not a vendor's. Messages are written here and
 * never assembled from captured output: a provider log can carry a prompt, a
 * path or a token, and the interface is the wrong place for any of it.
 */
export type FailureCode =
  /** The user pressed stop. Not a failure at all, and never retried for them. */
  | "cancelled"
  /** Leglas itself was shutting down and took the run with it. */
  | "stopped"
  /** The agent's binary could not be executed: gone from PATH, or not runnable. */
  | "missing-agent"
  /** The CLI ran and its provider refused the credentials. */
  | "not-signed-in"
  /** The provider was overloaded; the CLI exhausted its own retries. */
  | "provider-overloaded"
  /** The provider reported a rate or usage limit. */
  | "provider-limit"
  /** Codex refused the directory: no git repository and no trust on record. */
  | "needs-trust"
  /** The agent ran, did its own thing, and exited nonzero. */
  | "agent-error";

export type Failure = { code: FailureCode; message: string };

/**
 * A retry the vendor CLI announced while the run was still in flight.
 *
 * Claude Code prints one `system`/`api_retry` event per attempt, carrying the
 * attempt number, its ceiling and the HTTP status it is backing off from.
 * That is the only in-band signal Leglas gets during a stall, so it feeds
 * both the live status line and the verdict once the run gives up.
 */
export type RetryNotice = {
  attempt: number;
  /** The CLI's own retry ceiling, when it names one. */
  max: number | null;
  /** The HTTP status being retried, when the CLI names one. */
  status: number | null;
  /** The vendor's own word for it, lowercased: "overloaded", "authentication_failed". */
  reason: string | null;
};

export type FailureInput = {
  /** The agent's display name, because the user reads it. */
  agent: string;
  /** Leglas's own verdict where it has one: "cancelled", "stopped by SIGTERM", a spawn error. */
  error?: string | null;
  /** The exit code, when the child ran and exited on its own. */
  exitCode?: number | null;
  /** Recent output, read only for the shape of the failure and never quoted. */
  lines?: readonly string[];
  /** The last retry the CLI announced before it gave up. */
  retry?: RetryNotice | null;
};

/** codex-cli refuses a directory it neither trusts nor finds a git repo in. */
const NEEDS_TRUST = /not inside a trusted directory|--skip-git-repo-check/i;
/** Node's own spawn failures, which never reach the vendor at all. */
const MISSING_BINARY = /\b(ENOENT|EACCES|ENOTDIR)\b/;
const NOT_SIGNED_IN =
  /not logged in|not signed in|please (?:re-?)?(?:run|sign|log)\s*in|\/login\b|invalid api key|unauthorized|authentication_failed|\b401\b/i;
const LIMIT = /\b429\b|rate limit|usage limit|quota exceeded|too many requests/i;
const OVERLOADED = /\b(?:503|529)\b|overloaded|service unavailable/i;

function fromStatus(status: number | null, reason: string | null): FailureCode | null {
  if (status === 401 || status === 403 || reason === "authentication_failed") return "not-signed-in";
  if (status === 429 || reason === "rate_limit") return "provider-limit";
  if (status === 529 || status === 503 || reason === "overloaded") return "provider-overloaded";
  return null;
}

function fromLines(lines: readonly string[]): FailureCode | null {
  // Newest first: the last thing a CLI says about why it stopped is the thing
  // it stopped for. An early warning must not outrank a later refusal.
  for (const line of [...lines].reverse()) {
    if (NEEDS_TRUST.test(line)) return "needs-trust";
    if (NOT_SIGNED_IN.test(line)) return "not-signed-in";
    if (LIMIT.test(line)) return "provider-limit";
    if (OVERLOADED.test(line)) return "provider-overloaded";
  }
  return null;
}

function attempts(retry: RetryNotice | null | undefined): string {
  if (retry === null || retry === undefined) return "";
  const total = retry.max === null ? retry.attempt : Math.max(retry.attempt, retry.max);
  return ` It retried ${total} times first.`;
}

function message(code: FailureCode, input: FailureInput): string {
  const agent = input.agent;
  switch (code) {
    case "cancelled":
      return "You stopped this run.";
    case "stopped":
      return "Leglas shut down while this was running.";
    case "missing-agent":
      return `${agent} could not be started. Its command is not on this machine's PATH any more.`;
    case "not-signed-in":
      return `${agent} is not signed in. Sign in to it in a terminal, then run this again.`;
    case "provider-overloaded":
      return `${agent}'s provider was overloaded and gave up.${attempts(input.retry)}`;
    case "provider-limit":
      return `${agent} reported a rate or usage limit, so nothing ran.`;
    case "needs-trust":
      return `Codex refused this project: it is not a git repository and Codex has no trust on record for it.`;
    case "agent-error":
      return input.exitCode === null || input.exitCode === undefined
        ? `${agent} stopped without finishing. Its last output is in the Leglas terminal.`
        : `${agent} exited with code ${input.exitCode}. Its last output is in the Leglas terminal.`;
  }
}

/**
 * One verdict per ended run, in the order Leglas can trust it.
 *
 * What Leglas did itself outranks everything, because it is the only party
 * that knows a stop was deliberate. A spawn error comes next: the vendor
 * never ran, so nothing it might have said applies. Then the structured
 * retry notice, then the shape of the output, and finally the honest
 * fallback of an exit code with no story attached.
 */
export function classifyFailure(input: FailureInput): Failure {
  const lines = input.lines ?? [];
  const error = input.error ?? null;

  const code: FailureCode =
    error === "cancelled"
      ? "cancelled"
      : error !== null && /^stopped by /.test(error)
        ? "stopped"
        : error !== null && MISSING_BINARY.test(error)
          ? "missing-agent"
          : (error !== null ? fromLines([error]) : null) ??
            fromStatus(input.retry?.status ?? null, input.retry?.reason ?? null) ??
            fromLines(lines) ??
            "agent-error";

  return { code, message: message(code, input) };
}

/**
 * Whether a failure is about the conversation rather than the world.
 *
 * Only this shape earns the runner's one cold rerun. A dead session is
 * invisible to the user and costs a turn to recover; an overloaded provider,
 * a spent limit, a missing login or a refused directory will answer a second
 * run exactly as it answered the first, and the user pays for both. During an
 * outage that second run is another full vendor retry ladder aimed at a
 * provider that is already down.
 */
export function sessionShaped(code: FailureCode): boolean {
  return code === "agent-error";
}
