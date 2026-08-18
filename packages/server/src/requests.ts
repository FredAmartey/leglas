import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { describeAnnotations, type Annotation } from "./annotations.js";
import type { Preview } from "./config.js";
import type { Failure, FailureCode } from "./failure.js";

/**
 * What a change does to the direction it was sent at.
 *
 * `variant` builds a new direction beside the old one and leaves the old one
 * standing; `replace` edits it where it lies. Variant is the interface's
 * default because the whole tool is a comparison, and a change that overwrites
 * its own baseline destroys the thing being compared. Replace stays one click
 * away because not every change is a fork: a typo, a colour that is simply
 * wrong, or another pass at a variant made a minute ago all want the file
 * they already have.
 *
 * No default is assumed here. The two produce different work and one of them
 * cannot be undone, so the caller has to say which it means.
 */
export type RequestMode = "variant" | "replace";

export type ComposedRequest = { prompt: string; target: string | null; mode: RequestMode };

/** Only names the scaffold generates: no separators, no traversal. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;

export type VariantSlot = { surface: string; option: string };

/**
 * The surface and option a scaffold-generated URL names, if it names one.
 *
 * `/?v-hero=aurora` is the convention `leglas new` writes and `leglas explore`
 * teaches: surface "hero", option "aurora". Both halves are checked against
 * the scaffold's own naming before either is handed to a path or a command.
 */
export function variantSlot(url: string): VariantSlot | null {
  if (!url.startsWith("/")) return null;
  if (!url.includes("?")) return null;

  const query = url.slice(url.indexOf("?") + 1);
  for (const pair of query.split("&")) {
    const [rawKey, rawValue] = pair.split("=");
    if (rawKey === undefined || rawValue === undefined) continue;
    if (!rawKey.startsWith("v-")) continue;

    const surface = rawKey.slice(2);
    const option = decodeURIComponent(rawValue);
    if (!SAFE_SEGMENT.test(surface) || !SAFE_SEGMENT.test(option)) return null;
    return { surface, option };
  }
  return null;
}

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
  const slot = variantSlot(url);
  return slot === null ? null : `.leglas/variants/${slot.surface}/${slot.option}.tsx`;
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
export function composeRequest(
  preview: Preview,
  intent: string,
  mode: RequestMode,
  notes: readonly Annotation[] = [],
): ComposedRequest {
  // A file-backed preview names its own source; a URL has to be decoded.
  const target = preview.file ?? targetFor(preview.url);
  const cleaned = intent.trim();
  const asked = changeBlock(cleaned, notes);
  // What the new direction will record as the request behind it. Typed words
  // when there are any; otherwise the notes are the request, and a variant
  // that recorded an empty string would be the one thing on the rail nobody
  // can account for.
  const recorded =
    cleaned === ""
      ? notes
          .map((entry) => entry.note)
          .filter((entry) => entry !== "")
          .join("; ")
      : cleaned;

  const prompt =
    mode === "variant"
      ? variantPrompt(preview, recorded, asked, target)
      : replacePrompt(preview, asked, target);

  return { prompt, target, mode };
}

/**
 * How the anchors are to be read, said once rather than per note.
 *
 * The order is the order they go stale in. An agent handed a stale CSS path
 * and told nothing else will either edit the wrong element or give up; told
 * which facts to trust first, it finds the right one from the words on screen
 * almost every time.
 */
const ANCHORS =
  `Each path and rectangle was recorded when the note was left, against the ` +
  `design as it looked then. Trust the element's own words first, then its ` +
  `tag and classes, then the path, and treat the rectangle as a hint about ` +
  `where on the page to look rather than a fact.`;

/**
 * What was asked for: typed words, notes left on the design, or both.
 *
 * A note carries its own address, so the words left over are only about what
 * is wrong. That is the whole reason the pins exist, and why a request with
 * nothing typed into the composer is still a complete request.
 */
function changeBlock(cleaned: string, notes: readonly Annotation[]): string {
  if (notes.length === 0) return `What to change: ${cleaned}`;

  const many = notes.length === 1 ? "a note" : `${notes.length} notes`;
  const lead =
    cleaned === ""
      ? `What to change, left as ${many} on the design itself:`
      : `What to change: ${cleaned}\n\nAnd ${many} left on the design itself:`;

  return `${lead}\n\n${describeAnnotations(notes)}\n\n${ANCHORS}`;
}

/**
 * The closing rules both prompts share.
 *
 * Agents give an unscoped prompt the full treatment: survey the project, make
 * the edit, then verify with test runs and searches. For a design tweak the
 * verification is the run; the live preview shows the result the moment the
 * file is saved. Saying so is the single biggest speed lever this side of the
 * vendor, because the edit itself takes seconds.
 */
const SCOPE =
  `This is a scoped design change: no test run, no build, and no survey of ` +
  `the rest of the project is needed. The result is checked visually in a ` +
  `live preview, not by tooling.\n\n` +
  `Leave every other direction exactly as it is; they are alternatives being ` +
  `compared side by side, so changing a sibling destroys the comparison. Keep ` +
  `the change additive: do not rewrite shared components that other ` +
  `directions rely on.`;

function replacePrompt(preview: Preview, asked: string, target: string | null): string {
  const where =
    target === null
      ? `The direction is titled "${preview.title}" and renders at ${preview.url}. Find what produces it.`
      : `It lives at ${target}.`;
  const pace =
    target === null
      ? `Once found, make the change and finish. `
      : `Make the change in that file and finish. `;

  return (
    `In this project, change only the "${preview.title}" design direction. ${where}\n\n` +
    `${asked}\n\n` +
    `${pace}${SCOPE} The direction is already registered, so nothing needs ` +
    `re-registering.`
  );
}

/**
 * A change that branches instead of overwriting.
 *
 * Three things have to land or the new direction is not comparable with the
 * one it came from. It starts as a copy of the parent's source, so what
 * reaches the rail is the parent plus the change rather than a fresh design
 * wearing a related name. It is registered with `--based-on`, which is what
 * puts it under its parent in the rail and makes the parent its default
 * comparison. And it carries the request that produced it, in the user's own
 * words, because a fortnight later the rail is a row of names nobody can
 * account for.
 *
 * Registration is a CLI call rather than a file the agent writes, because
 * `leglas add` is the same path `leglas explore` already teaches and it
 * validates the entry before it can reach the rail broken.
 */
function variantPrompt(
  preview: Preview,
  recorded: string,
  asked: string,
  target: string | null,
): string {
  const slot = variantSlot(preview.url);
  const parent = JSON.stringify(preview.title);
  const askedFor = JSON.stringify(recorded);

  const source =
    target === null
      ? `Find what renders it first.`
      : `Its source is ${target}.`;

  // Where the copy goes, and how the finished direction is named back to
  // Leglas, is the one part that differs by how the parent is served.
  const [make, register] =
    preview.file !== undefined
      ? [
          `Copy that file to a new file beside it and make the change in the copy.`,
          `  npx leglas add --title "<name>" --file "<the new file>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
        ]
      : slot !== null
        ? [
            `Copy that file to a new one in the same folder and make the change ` +
              `in the copy. The new file's name without its extension is its key, ` +
              `and that key has to be listed in the DIRECTIONS map in ` +
              `.leglas/variants/${slot.surface}/switch.tsx or its URL will not resolve.`,
            `  npx leglas add --title "<name>" --url "/?v-${slot.surface}=<key>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
          ]
        : [
            `Copy its source rather than editing it, and make the change in the ` +
              `copy. Add the new direction the way this project already switches ` +
              `between them; if it has a Leglas branch point, that is the ` +
              `DIRECTIONS map in .leglas/variants/<surface>/switch.tsx.`,
            `  npx leglas add --title "<name>" --url "<the URL that shows it>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
          ];

  return (
    `In this project, add a new design direction based on the ` +
    `"${preview.title}" direction. Leave "${preview.title}" itself exactly as ` +
    `it is: it is the thing the new one will be compared against.\n\n` +
    `${source} ${make}\n\n` +
    `${asked}\n\n` +
    `Then register it, which is what puts it on the rail:\n\n` +
    `${register}\n\n` +
    `Name it for its idea rather than numbering it, and keep the name short ` +
    `enough to read in a narrow rail. Pass --asked-for exactly as given above; ` +
    `it is the user's own words and the interface shows them. Registering it ` +
    `is the last step; finish there.\n\n` +
    `${SCOPE}`
  );
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
  /**
   * Whether this change forks the direction or rewrites it. Absent on a
   * request written before the distinction existed, which the reader treats
   * as `replace`: that is what those requests actually did.
   */
  mode?: RequestMode;
  /**
   * The notes this change answers, by id. Present only when pins were left.
   * A change made in place forgets them once it lands, because the design
   * they point at is the one that was just rewritten.
   */
  notes?: readonly string[];
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
        mode: entry.mode === "variant" ? "variant" : "replace",
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
