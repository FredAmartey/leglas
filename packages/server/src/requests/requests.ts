import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { describeAnnotations, type Annotation } from "./annotations.js";
import { capturedViewport, removeCaptures, type Attachment, type Captured } from "./attachments.js";
import type { Preview } from "../config/config.js";
import type { Failure, FailureCode } from "../agents/failure.js";

import { isString, isJsonRecord, parseJson, type JsonValue, type JsonRecord } from "../json.js";

/**
 * What a change does to its direction. `variant` builds a new direction beside
 * it; `replace` edits it in place. Variant is the interface's default, since
 * overwriting the baseline destroys the comparison; replace suits a typo, a
 * wrong colour or another pass at a fresh variant. No default here: the two
 * differ and one can't be undone, so the caller says which.
 */
export type RequestMode = "variant" | "replace";

export type ComposedRequest = { prompt: string; target: string | null; mode: RequestMode };

/** Only names the scaffold generates: no separators, no traversal. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;

export type VariantSlot = { surface: string; option: string };

/**
 * The surface and option a scaffold URL names, if any: `/?v-hero=aurora` is
 * surface "hero", option "aurora". Both are checked against the scaffold's
 * naming before reaching a path or command.
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
 * The file behind a preview when its URL came from `leglas new`:
 * `/?v-hero=aurora` lives at `.leglas/variants/hero/aurora.tsx`, so a request
 * can name the file. Other URLs yield nothing and the request describes the
 * preview instead.
 */
export function targetFor(url: string): string | null {
  const slot = variantSlot(url);

  return slot === null ? null : `.leglas/variants/${slot.surface}/${slot.option}.tsx`;
}

/**
 * Turns an intent from the interface into a request an agent can act on without
 * a conversation. Leglas runs no model; the user's agent already knows their
 * conventions and taste.
 */
export function composeRequest(
  preview: Preview,
  intent: string,
  mode: RequestMode,
  notes: readonly Annotation[] = [],
  leglasCommand = "npx -y leglas",
  captured: Captured | null = null,
): ComposedRequest {
  // A file-backed preview names its own source; a URL has to be decoded.
  const target = preview.file ?? targetFor(preview.url);
  const cleaned = intent.trim();
  const asked = changeBlock(cleaned, notes);

  // What the new direction records as its request: the typed words, or else the
  // notes, so no variant on the rail has an empty reason.
  const recorded =
    cleaned === ""
      ? notes.flatMap((entry) => (entry.note !== "" ? [entry.note] : [])).join("; ")
      : cleaned;

  const prompt =
    mode === "variant"
      ? variantPrompt(preview, recorded, asked, target, leglasCommand, captured)
      : replacePrompt(preview, asked, target, leglasCommand, captured);

  return { prompt, target, mode };
}

/**
 * How to read the anchors, said once, in the order they go stale. Told which
 * facts to trust first, an agent finds the element from its words almost every
 * time instead of editing the wrong one from a stale CSS path.
 */
const ANCHORS =
  `Each path and rectangle was recorded when the note was left, against the ` +
  `design as it looked then. Trust the element's own words first, then its ` +
  `tag and classes, then the path, and treat the rectangle as a hint about ` +
  `where on the page to look rather than a fact.`;

/**
 * What was asked for: typed words, notes, or both. Notes carry their own
 * address, so a request with nothing typed is still complete.
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
 * The closing rules both prompts share. Agents give an unscoped prompt the full
 * survey, edit and test cycle, but for a design tweak the live preview is the
 * check. Saying so is the biggest speed lever this side of the vendor.
 */
function scope(leglasCommand: string, quotedTitle: string | null): string {
  // A file-served direction joins the rail after a restart, so asking for a
  // look would send the agent at a 404 it's told not to fix by restarting.
  const look =
    quotedTitle === null
      ? `A file direction joins the rail after Leglas restarts, so there is ` +
        `nothing to screenshot yet; finish once it is registered.`
      : `When the change is made, look at it once: run \`${leglasCommand} show ` +
        `${quotedTitle} --screenshot\` and read the PNG it writes. Fix anything visibly ` +
        `broken, then finish.`;

  return (
    `This request came from the running Leglas interface. Request collection, ` +
    `direction discovery and the live-server check are already complete. Do not ` +
    `run Leglas explore, requests, list, help or version commands, do not ` +
    `inspect package caches, and do not start or restart the app or Leglas. ` +
    `${look}\n\n` +
    `This is a scoped design change: no test run, no build, and no survey of ` +
    `the rest of the project is needed. The result is checked visually in a ` +
    `live preview, not by tooling.\n\n` +
    `Leave every other direction exactly as it is; they are alternatives being ` +
    `compared side by side, so changing a sibling destroys the comparison. Keep ` +
    `the change additive: do not rewrite shared components that other ` +
    `directions rely on. A shared script may gain one small per-direction ` +
    `override, at the point it reads what it renders, that defaults to what it ` +
    `renders today; every other direction then renders exactly as before, so ` +
    `that counts as additive.`
  );
}

/** The images and load evidence placed between the ask and the closing rules. */
function capturedBlock(captured: Captured | null): string {
  if (
    captured === null ||
    (captured.attachments.length === 0 &&
      captured.errors.length === 0 &&
      captured.hydration === null &&
      captured.skipped === null)
  )
    return "";

  const lines: string[] = [];

  const frames = captured.attachments.filter(
    (attachment) => attachment.kind === "frame" || attachment.kind === "note",
  );

  const frame = frames.find((attachment) => attachment.kind === "frame");

  if (frames.length > 0) {
    const viewport =
      frame?.viewport ??
      frames.find((attachment) => attachment.viewport !== undefined)?.viewport ??
      capturedViewport(captured) ??
      1440;

    lines.push(
      `What it looks like, from a fresh load at ${viewport}px wide with nothing interacted with:`,
    );

    for (const attachment of frames) {
      if (attachment.kind === "frame") {
        lines.push(
          `  ${attachment.file}  ${captured.cut ? "the top 4000px of the page" : "the whole page"}`,
        );
        continue;
      }

      const number = /note-(\d+)\.png$/.exec(attachment.file)?.[1] ?? attachment.note ?? "?";
      lines.push(`  ${attachment.file}  what note ${number} points at, with room around it`);
    }
  }

  const comparison = captured.attachments.find((attachment) => attachment.kind === "compare");

  if (comparison !== undefined) {
    lines.push(
      `Alongside it on screen is ${JSON.stringify(comparison.title ?? "the other direction")}, ` +
        `the direction it is being compared with; "the other one" means it:`,
      `  ${comparison.file}`,
    );
  }

  const references = captured.attachments.filter((attachment) => attachment.kind === "reference");

  if (references.length > 0) {
    lines.push("Reference images the user attached, which show what they mean:");

    for (const reference of references) lines.push(`  ${reference.file}`);
  }

  if (captured.errors.length > 0) {
    lines.push(
      `On load it logged ${captured.errors.length} console ${captured.errors.length === 1 ? "error" : "errors"}:`,
    );

    for (const error of captured.errors) lines.push(`  - ${error}`);
  }

  if (captured.hydration !== null) {
    lines.push(
      `After load, ${captured.hydration.framework} rebuilt this page in the browser from the app's own ` +
        `JavaScript and data (${captured.hydration.message}). Markup edited in the served HTML shows for ` +
        `a moment and is then replaced, so make the change where that JavaScript gets what it renders: ` +
        `the data or source it reads, or a per-direction override that a shared script reads with the ` +
        `original as its default. Look at the result a few seconds after load, not at first paint.`,
    );
  }

  if (captured.skipped !== null) {
    lines.push(`(${captured.skipped} Use the live preview instead.)`);
  }

  if (captured.attachments.length > 0) {
    // Last, so the block ends on the thing to do. Said as files because only
    // the embedded Codex and Claude sessions get the pictures directly; the
    // Claude CLI fallback, Cursor, a custom command and `leglas watch` get only
    // this text, and all of them can open a file.
    lines.push(
      "Each path above is a file in this project. Open every one and look at it before changing anything.",
    );
  }

  return `\n\n${lines.join("\n")}`;
}

/**
 * A value as one double-quoted shell argument. JSON escaping stops a quote
 * ending it, but a shell still expands `$(...)`, backticks and backslashes
 * inside double quotes, and the runner pre-approves this command, so it must be
 * inert. Plain text comes out as JSON.stringify would.
 */
function shellArgument(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`;
}

/**
 * The exact command a fork's prompt says to run to register. The runner
 * pre-approves this prefix for a CLI that can't ask mid-run, so prompt and
 * allowance share one source: a mismatch is either a hole or a run that builds
 * everything and registers nothing.
 */
export function registrationCommand(leglasCommand: string): string {
  return `${leglasCommand} add`;
}

function replacePrompt(
  preview: Preview,
  asked: string,
  target: string | null,
  leglasCommand: string,
  captured: Captured | null,
): string {
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
    `${asked}${capturedBlock(captured)}\n\n` +
    `${pace}${scope(leglasCommand, shellArgument(preview.title))} The direction is already registered, so nothing needs ` +
    `re-registering.`
  );
}

/**
 * A change that branches instead of overwriting. Three things must land for it
 * to be comparable: it starts as a copy of the parent's source; it registers
 * with `--based-on`, which nests it under its parent and makes the parent its
 * default comparison; and it records the request in the user's own words.
 * Registration goes through `leglas add`, which validates the entry before it
 * reaches the rail.
 */
function variantPrompt(
  preview: Preview,
  recorded: string,
  asked: string,
  target: string | null,
  leglasCommand: string,
  captured: Captured | null,
): string {
  const slot = variantSlot(preview.url);
  const parent = shellArgument(preview.title);
  const askedFor = shellArgument(recorded);
  const add = registrationCommand(leglasCommand);

  const source = target === null ? `Find what renders it first.` : `Its source is ${target}.`;

  // Where the copy goes and how the direction is registered depend on how the
  // parent is served.
  const [make, register] =
    preview.file !== undefined
      ? [
          `Copy that file to a new file beside it and make the change in the copy.`,
          `  ${add} --title "<name>" --file "<the new file>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
        ]
      : slot !== null
        ? [
            `Copy that file to a new one in the same folder and make the change ` +
              `in the copy. The new file's name without its extension is its key, ` +
              `and that key has to be listed in the DIRECTIONS map in ` +
              `.leglas/variants/${slot.surface}/switch.tsx or its URL will not resolve.`,
            `  ${add} --title "<name>" --url "/?v-${slot.surface}=<key>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
          ]
        : [
            `Copy its source rather than editing it, and make the change in the ` +
              `copy. Add the new direction the way this project already switches ` +
              `between them; if it has a Leglas branch point, that is the ` +
              `DIRECTIONS map in .leglas/variants/<surface>/switch.tsx.`,
            `  ${add} --title "<name>" --url "<the URL that shows it>" --based-on ${parent} --note "<what this direction is, one line>" --asked-for ${askedFor}`,
          ];

  return (
    `In this project, add a new design direction based on the ` +
    `"${preview.title}" direction. Leave "${preview.title}" itself exactly as ` +
    `it is: it is the thing the new one will be compared against.\n\n` +
    `${source} ${make}\n\n` +
    `${asked}${capturedBlock(captured)}\n\n` +
    `Then register it, which is what puts it on the rail:\n\n` +
    `${register}\n\n` +
    `Name it for its idea rather than numbering it, and keep the name short ` +
    `enough to read in a narrow rail. Pass --asked-for exactly as given above; ` +
    `it is the user's own words and the interface shows them. ` +
    `${
      preview.file !== undefined
        ? "Registering it is the last step; finish there."
        : "Register it before you look: the look is at the registered direction."
    }\n\n` +
    `${scope(leglasCommand, preview.file !== undefined ? null : '"the title you registered"')}`
  );
}

/** Where pending requests wait for an agent to collect them. */
export const REQUESTS_PATH = ".leglas/requests.json";

/**
 * Where a request has got to. `queued` and `picked-up` are live, and removal is
 * the only completion signal. The terminal states exist because a run that
 * ended badly used to be tracked only in memory: after a restart it read as
 * `picked-up`, and the interface said "your agent is on it" for days with no
 * way to dismiss it.
 */
export type RequestStatus = "queued" | "picked-up" | "failed" | "cancelled";

/**
 * The shape of an id Leglas minted. An id names a `.leglas/captures/` directory
 * removed with its request, so a hand-edited queue must not point that removal
 * elsewhere.
 */
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,32}$/;

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
  attachments?: readonly Attachment[];
  captureNote?: string;
  /**
   * What was on screen beside the words: the compared direction and the
   * reference ids that were attached. Kept as asked rather than as captured,
   * because a duplicate is a repeat of the ask, and a capture can fail.
   */
  compare?: string;
  references?: readonly string[];
};

/**
 * Every verdict the runner writes, keyed so the compiler notices a new one; the
 * reader drops unknown codes, so a missing one would vanish from the card.
 */
const FAILURE_CODES: Record<FailureCode, true> = {
  cancelled: true,
  stopped: true,
  "missing-agent": true,
  "not-signed-in": true,
  "provider-overloaded": true,
  "provider-limit": true,
  "needs-trust": true,
  "not-registered": true,
  "agent-error": true,
  "agent-silent": true,
};

function isFailureCode(value: unknown): value is FailureCode {
  return isString(value) && Object.hasOwn(FAILURE_CODES, value);
}

function failureOf(entry: JsonValue | undefined): Failure | null {
  if (!isJsonRecord(entry)) return null;

  if (!isString(entry.message) || entry.message === "") return null;

  if (!isFailureCode(entry.code)) return null;

  return { code: entry.code, message: entry.message };
}

export async function readRequests(cwd: string): Promise<PendingRequest[]> {
  try {
    const raw = await readFile(join(cwd, REQUESTS_PATH), "utf8");
    const parsed = parseJson(raw);

    if (!isJsonRecord(parsed) || !Array.isArray(parsed.requests)) return [];

    return parsed.requests.map((request, index) => {
      const source = isJsonRecord(request)
        ? request
        : Array.isArray(request)
          ? Object.fromEntries(Object.entries(request))
          : {};

      const {
        failure: rawFailure,
        attachments: rawAttachments,
        captureNote: rawCaptureNote,
        compare: rawCompare,
        references: rawReferences,
        ...entry
      } = source;

      const status: RequestStatus =
        entry.status === "picked-up" || entry.status === "failed" || entry.status === "cancelled"
          ? entry.status
          : "queued";

      // A verdict is read back only in its written shape and only on an ended
      // request. Anything else is hand-edited, and no reason beats an
      // untrustworthy one.
      const failure = isTerminal(status) ? failureOf(rawFailure) : null;

      const id = isString(entry.id) && REQUEST_ID.test(entry.id) ? entry.id : String(index);

      // Attachments are sent to a model, so a queue path is trusted only in the
      // shape Leglas writes: one plain file name inside this request's capture
      // directory.
      const ownFile = new RegExp(`^\\.leglas/captures/${id}/[A-Za-z0-9][A-Za-z0-9_.-]*$`);

      const attachments = Array.isArray(rawAttachments)
        ? rawAttachments.filter(
            (attachment) =>
              isJsonRecord(attachment) &&
              isString(attachment.file) &&
              ownFile.test(attachment.file) &&
              !attachment.file.includes("..") &&
              ["frame", "note", "compare", "reference"].includes(String(attachment.kind)),
          )
        : null;

      const loaded = {
        ...entry,
        id,
        status,
        mode: entry.mode === "variant" ? ("variant" as const) : ("replace" as const),
      };

      const optional: JsonRecord = {};

      if (failure !== null) optional.failure = failure;

      if (attachments !== null && attachments.length > 0) optional.attachments = attachments;

      if (isString(rawCaptureNote)) optional.captureNote = rawCaptureNote;

      if (isString(rawCompare)) optional.compare = rawCompare;

      if (Array.isArray(rawReferences) && rawReferences.every(isString))
        optional.references = rawReferences;

      // SAFETY: The queue writer owns the remaining request and image metadata; this reader
      // preserves those legacy fields while normalizing identity, status and owned file paths.
      return { ...loaded, ...optional } as PendingRequest;
    });
  } catch {
    // No queue yet, or unreadable: nothing is pending, and a broken queue must
    // never stop the interface.
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
  id = newRequestId(),
): Promise<void> {
  await writeQueue(cwd, [...(await readRequests(cwd)), { ...request, id, status: "queued" }]);
}

export function newRequestId(): string {
  return randomBytes(6).toString("base64url");
}

export async function collectRequests(cwd: string): Promise<PendingRequest[]> {
  const requests = await readRequests(cwd);

  // An ended request isn't work: handing over a cancelled one asks for the
  // change the user stopped, and a failed one spends a turn on what already
  // broke.
  const collected = requests.map((request) =>
    isTerminal(request.status) ? request : { ...request, status: "picked-up" as const },
  );

  // Collecting an empty queue writes nothing: agents run this speculatively,
  // and a probe must not create .leglas/ in an unused project.
  if (requests.some((request) => request.status === "queued")) await writeQueue(cwd, collected);

  return collected.filter((request) => !isTerminal(request.status));
}

/**
 * Marks one request as taken. collectRequests hands over the whole queue for an
 * agent that works through it; watch takes one at a time, and flipping them all
 * would show unstarted directions as in progress.
 */
export async function markPickedUp(cwd: string, id: string): Promise<boolean> {
  const requests = await readRequests(cwd);

  if (!requests.some((request) => request.id === id && request.status !== "picked-up"))
    return false;
  await writeQueue(
    cwd,
    requests.map((request) =>
      request.id === id ? { ...request, status: "picked-up" as const } : request,
    ),
  );

  return true;
}

/**
 * Records how a run ended so it outlives the process. The request stays so the
 * interface can show it, offer a rerun and let the user dismiss it; it just
 * can't pass for work in flight, to a restarted server, `leglas requests` or a
 * channel host.
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
 * Drops one request, the only way a request completes. No "done" status, or the
 * queue becomes a log nobody reads. One id, so anything queued meanwhile
 * survives.
 */
export async function removeRequest(cwd: string, id: string): Promise<boolean> {
  const requests = await readRequests(cwd);
  const remaining = requests.filter((request) => request.id !== id);

  if (remaining.length === requests.length) return false;
  await writeQueue(cwd, remaining);
  await removeCaptures(cwd, id).catch(() => {});

  return true;
}

/**
 * Acknowledges collected work and reports what's still waiting. Only picked-up
 * requests go: the user keeps typing, and a request queued after collection
 * hasn't been read yet. The survivors are what the next `requests` call hands
 * over.
 */
export async function clearRequests(cwd: string): Promise<{ cleared: number; pending: number }> {
  const requests = await readRequests(cwd);
  // Pending is what nobody has taken. An ended request isn't waiting, so it's
  // swept with the collected ones.
  const pending = requests.filter((request) => request.status === "queued");
  const cleared = requests.length - pending.length;

  // Like collecting: acknowledging nothing must not create .leglas/ in a fresh
  // project.
  if (cleared > 0) {
    await writeQueue(cwd, pending);
    await Promise.all(
      requests
        .filter((request) => request.status !== "queued")
        .map((request) => removeCaptures(cwd, request.id).catch(() => {})),
    );
  }

  return { cleared, pending: pending.length };
}
