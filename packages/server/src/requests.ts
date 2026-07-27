import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Preview } from "./config.js";

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
  const target = targetFor(preview.url);
  const cleaned = intent.trim();

  const where =
    target === null
      ? `The direction is titled "${preview.title}" and renders at ${preview.url}. Find what produces it.`
      : `It lives at ${target}.`;

  const prompt =
    `In this project, change only the "${preview.title}" design direction. ${where}\n\n` +
    `What to change: ${cleaned}\n\n` +
    `Leave every other direction exactly as it is; they are alternatives being ` +
    `compared side by side, so changing a sibling destroys the comparison. The ` +
    `direction is already registered, so nothing needs re-registering. Keep the ` +
    `change additive: do not rewrite shared components that other directions rely on.`;

  return { prompt, target };
}

/** Where pending requests wait for an agent to collect them. */
export const REQUESTS_PATH = ".leglas/requests.json";

export type PendingRequest = {
  title: string;
  url: string;
  intent: string;
  target: string | null;
  prompt: string;
};

export async function readRequests(cwd: string): Promise<PendingRequest[]> {
  try {
    const raw = await readFile(join(cwd, REQUESTS_PATH), "utf8");
    const parsed = JSON.parse(raw) as { requests?: unknown };
    return Array.isArray(parsed.requests) ? (parsed.requests as PendingRequest[]) : [];
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

export async function appendRequest(cwd: string, request: PendingRequest): Promise<void> {
  await writeQueue(cwd, [...(await readRequests(cwd)), request]);
}

export async function clearRequests(cwd: string): Promise<void> {
  await writeQueue(cwd, []);
}
