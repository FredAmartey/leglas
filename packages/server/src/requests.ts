import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import type { Preview } from "./config.js";
import type { Failure, FailureCode } from "./failure.js";

export type ComposedRequest = { prompt: string; target: string | null };

/** Only names the scaffold generates: no separators, no traversal. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The file behind a preview, when the URL was produced by `leglas new`.
 *
 * The scaffold's own convention pays off here: `/?v-hero=aurora` means the
 * direction lives at `.leglas/variants/hero/aurora.tsx`, so a request can name
 * the exact file instead of asking an agent to go looking. A URL that does not
 * follow the convention yields nothing, and the request degrades to describing
 * the preview rather than pointing at a file that may not exist.
 */
export function targetFor(url: string): string | null {
  if (!url.startsWith("/")) return null;

  const query = url.slice(url.indexOf("?") + 1);
  if (!url.includes("?")) return null;

  for (const pair of query.split("&")) {
    const [rawKey, rawValue] = pair.split("=");
    if (rawKey === undefined || rawValue === undefined) continue;
    if (!rawKey.startsWith("v-")) continue;

    const surface = rawKey.slice(2);
    const option = decodeURIComponent(rawValue);
    if (!SAFE_SEGMENT.test(surface) || !SAFE_SEGMENT.test(option)) return null;
    return `.leglas/variants/${surface}/${option}.tsx`;
  }
  return null;
}

/**
 * Turn an intent expressed in the interface into a request an agent can act on
 * without a conversation.
 *
 * Leglas does not run a model. The user's own agent already knows their
 * conventions, their design system, and their taste, which is context no
 * external worker can have. What was missing was locality: expressing the
 * intent meant leaving the interface for a terminal. This closes that without
 * taking over generation.
 */
export function composeRequest(preview: Preview, intent: string): ComposedRequest {
  // A file-backed preview names its own source; a URL has to be decoded.
  const target = preview.file ?? targetFor(preview.url);
  const cleaned = intent.trim();

  const where =
    target === null
      ? `The direction is titled "${preview.title}" and renders at ${preview.url}. Find what produces it.`
      : `It lives at ${target}.`;

  // Agents give an unscoped prompt the full treatment: survey the project,
  // make the edit, then verify with test runs and searches. For a design
  // tweak the verification is the run; the live preview shows the result the
  // moment the file is saved. Saying so is the single biggest speed lever
  // this side of the vendor: the edit itself takes seconds.
  const pace =
    target === null
      ? `Once found, make the change and finish. `
      : `Make the change in that file and finish. `;

  const prompt =
    `In this project, change only the "${preview.title}" design direction. ${where}\n\n` +
    `What to change: ${cleaned}\n\n` +
    `${pace}This is a scoped design change: no test run, no build, and no ` +
    `survey of the rest of the project is needed. The result is checked ` +
    `visually in a live preview, not by tooling.\n\n` +
    `Leave every other direction exactly as it is; they are alternatives being ` +
    `compared side by side, so changing a sibling destroys the comparison. The ` +
    `direction is already registered, so nothing needs re-registering. Keep the ` +
    `change additive: do not rewrite shared components that other directions rely on.`;

  return { prompt, target };
}

/** Where pending requests wait for an agent to collect them. */
export const REQUESTS_PATH = ".leglas/requests.json";

/**
 * Where a request has got to.
 *
 * `queued` and `picked-up` are the live half, and removal is still the only
 * completion signal the tool can stand behind: an agent that finished has
 * nothing left to say. The two terminal states exist because the opposite is
 * not true of a run that ended badly. That used to live only in the running
 * server's memory, so a restart read a stopped or failed request back as
 * `picked-up` and the interface said "your agent is on it" about a run that
 * had been over for days, with no way to dismiss it.
 */
export type RequestStatus = "queued" | "picked-up" | "failed" | "cancelled";

const TERMINAL: readonly RequestStatus[] = ["failed", "cancelled"];

/** Whether a request is finished with, one way or the other. */
export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL.includes(status);
}

export type PendingRequest = {
  id: string;
  status: RequestStatus;
  title: string;
  url: string;
  intent: string;
  target: string | null;
  prompt: string;
  /** Why it ended, on a terminal request. Absent on every other status. */
  failure?: Failure;
};

const FAILURE_CODES: readonly FailureCode[] = [
  "cancelled",
  "stopped",
  "missing-agent",
  "not-signed-in",
  "provider-overloaded",
  "provider-limit",
  "needs-trust",
  "agent-error",
];

function failureOf(value: unknown): Failure | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<Failure>;
  if (typeof entry.message !== "string" || entry.message === "") return null;
  if (entry.code === undefined || !FAILURE_CODES.includes(entry.code)) return null;
  return { code: entry.code, message: entry.message };
}

export async function readRequests(cwd: string): Promise<PendingRequest[]> {
  try {
    const raw = await readFile(join(cwd, REQUESTS_PATH), "utf8");
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.map((request, index) => {
      const { failure: rawFailure, ...entry } = request as Partial<PendingRequest>;
      const status: RequestStatus =
        entry.status === "picked-up" ||
        entry.status === "failed" ||
        entry.status === "cancelled"
          ? entry.status
          : "queued";
      // A verdict is only read back in the shape it was written, and only on a
      // request that ended. Anything else in that slot is a hand-edited file,
      // and a request with no reason reads better than one carrying a reason
      // nobody can trust.
      const failure = isTerminal(status) ? failureOf(rawFailure) : null;
      return {
        ...entry,
        id: typeof entry.id === "string" ? entry.id : String(index),
        status,
        ...(failure === null ? {} : { failure }),
      } as PendingRequest;
    });
  } catch {
    // No queue yet, or an unreadable one. Either way nothing is pending, and a
    // broken queue must never stop the interface from working.
    return [];
  }
}

async function writeQueue(cwd: string, requests: PendingRequest[]): Promise<void> {
  const path = join(cwd, REQUESTS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ requests }, null, 2)}\n`, "utf8");
}

export async function appendRequest(
  cwd: string,
  request: Omit<PendingRequest, "id" | "status">,
): Promise<void> {
  await writeQueue(cwd, [
    ...(await readRequests(cwd)),
    { ...request, id: randomBytes(6).toString("base64url"), status: "queued" },
  ]);
}

export async function collectRequests(cwd: string): Promise<PendingRequest[]> {
  const requests = await readRequests(cwd);
  // A request that already ended is not work: handing a cancelled one to an
  // agent would ask for the change the user just stopped, and handing over a
  // failed one spends a turn on the thing that already broke.
  const collected = requests.map((request) =>
    isTerminal(request.status) ? request : { ...request, status: "picked-up" as const },
  );
  // Collecting an empty queue writes nothing: this is the one command agents
  // run speculatively, and a probe must not materialise .leglas/ in a project
  // that never used the interface.
  if (requests.some((request) => request.status === "queued")) await writeQueue(cwd, collected);
  return collected.filter((request) => !isTerminal(request.status));
}

/**
 * Mark one request as taken, leaving the rest of the queue alone.
 *
 * collectRequests hands the whole queue over at once, which is right for an
 * agent that reads them all and works through them itself. Watch takes one at
 * a time, and flipping every request to picked-up would tell the interface
 * that directions nobody has started are already being worked on.
 */
export async function markPickedUp(cwd: string, id: string): Promise<boolean> {
  const requests = await readRequests(cwd);
  if (!requests.some((request) => request.id === id && request.status !== "picked-up")) return false;
  await writeQueue(
    cwd,
    requests.map((request) =>
      request.id === id ? { ...request, status: "picked-up" as const } : request,
    ),
  );
  return true;
}

/**
 * Write down how a run ended, so the record outlives the process that ran it.
 *
 * The request stays in the queue: the interface still has to show it, offer a
 * rerun and let the user let it go. What changes is that it can no longer be
 * mistaken for work in flight, by this server after a restart, by `leglas
 * requests`, or by a channel host reading the same file.
 */
export async function markFailed(cwd: string, id: string, failure: Failure): Promise<boolean> {
  const requests = await readRequests(cwd);
  if (!requests.some((request) => request.id === id)) return false;
  await writeQueue(
    cwd,
    requests.map((request) =>
      request.id === id
        ? {
            ...request,
            status: failure.code === "cancelled" ? ("cancelled" as const) : ("failed" as const),
            failure,
          }
        : request,
    ),
  );
  return true;
}

/**
 * Drop one request, which is the only way a request completes.
 *
 * There is no "done" status: an agent that finished has nothing further to say
 * about the request, and a queue that keeps finished entries becomes a log
 * nobody reads. Scoped to a single id because anything queued while the agent
 * was working has to survive.
 */
export async function removeRequest(cwd: string, id: string): Promise<boolean> {
  const requests = await readRequests(cwd);
  const remaining = requests.filter((request) => request.id !== id);
  if (remaining.length === requests.length) return false;
  await writeQueue(cwd, remaining);
  return true;
}

/**
 * Acknowledge the work that was collected, and report what is still waiting.
 *
 * Scoped to picked-up requests rather than the whole file, because the user
 * keeps typing while the agent works: a request queued after the collection is
 * one nobody has read yet, and emptying the file would throw it away silently,
 * on the word of a toast that said it had landed. What survives here is what
 * the next `requests` call hands over.
 */
export async function clearRequests(cwd: string): Promise<{ cleared: number; pending: number }> {
  const requests = await readRequests(cwd);
  // Pending is what nobody has taken yet. A request that ended, well or
  // badly, is not waiting for anyone, so clearing sweeps it up with the
  // collected ones rather than reporting it as outstanding work.
  const pending = requests.filter((request) => request.status === "queued");
  const cleared = requests.length - pending.length;
  // Same reason collecting an empty queue writes nothing: acknowledging work
  // that was never there must not materialise .leglas/ in a fresh project.
  if (cleared > 0) await writeQueue(cwd, pending);
  return { cleared, pending: pending.length };
}
