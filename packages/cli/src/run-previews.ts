import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { addLocalPreview, clearRequests, loadConfig, readLocalPreviews, readRequests } from "@leglas/server";

import { ignoreEntry } from "./ignore.js";

import type { AddPreview } from "./args.js";

export type PreviewDeps = { log(line: string): void; error(line: string): void };

export type PreviewResult = { exitCode: number };

/**
 * Every command prints a single JSON envelope under --json, with a stable
 * shape and exit code, so an agent and a human drive the same surface.
 */
function envelope(deps: PreviewDeps, ok: boolean, body: Record<string, unknown>): void {
  deps.log(JSON.stringify({ ok, ...body }));
}

/**
 * Register a preview locally.
 *
 * Adding is local by default: exploration is short-lived and its code lives in
 * a gitignored directory, so a teammate must never receive a config entry
 * pointing at something they do not have. Sharing is a separate, deliberate
 * step.
 */
async function ensureIgnored(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  const next = ignoreEntry(current);
  if (next !== null) await writeFile(path, next, "utf8");
}

export async function runAdd(
  options: { preview: AddPreview; json: boolean; cwd: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const loaded = await loadConfig(options.cwd);
  const shared = loaded.config?.previews ?? [];

  const outcome = await addLocalPreview(
    options.cwd,
    {
      title: options.preview.title,
      url: options.preview.url,
      note: options.preview.note,
      tags: options.preview.tags,
    },
    shared,
  );

  if (!outcome.ok) {
    if (options.json) envelope(deps, false, { error: outcome.error });
    else deps.error(outcome.error ?? "Could not add the preview.");
    return { exitCode: 1 };
  }

  // The directory now exists, so it must be ignored before anything can
  // sweep it into a commit.
  await ensureIgnored(options.cwd);

  if (options.json) {
    envelope(deps, true, { added: options.preview.title, url: options.preview.url, local: true });
  } else {
    deps.log(`  added  ${options.preview.title}  ${options.preview.url}`);
    deps.log("");
    deps.log("Local to this machine. Restart Leglas to see it, or run leglas list.");
  }
  return { exitCode: 0 };
}

export async function runList(
  options: { json: boolean; cwd: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const errors = [...loaded.errors, ...local.errors];

  const previews = [
    ...(loaded.config?.previews ?? []).map((preview) => ({ ...preview, local: false })),
    ...local.previews,
  ];

  if (options.json) {
    envelope(deps, errors.length === 0, {
      previews: previews.map((preview) => ({
        title: preview.title,
        url: preview.url,
        local: preview.local,
      })),
      errors,
    });
    return { exitCode: errors.length === 0 ? 0 : 1 };
  }

  if (previews.length === 0) {
    deps.log("No previews yet. Add one with leglas add, or list them in leglas.config.ts.");
  } else {
    const width = Math.max(...previews.map((preview) => preview.title.length));
    for (const preview of previews) {
      const scope = preview.local ? "  (local)" : "";
      deps.log(`  ${preview.title.padEnd(width)}  ${preview.url}${scope}`);
    }
  }

  for (const error of errors) deps.error(`  ! ${error}`);
  return { exitCode: errors.length === 0 ? 0 : 1 };
}

/**
 * Hand pending requests to whoever asks. An agent polls this, acts on each
 * prompt, and clears the queue. Leglas runs no model of its own: the user's
 * agent already knows their conventions and design system, which is context
 * no external worker can have.
 */
export async function runRequests(
  options: { json: boolean; clear: boolean; cwd: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  if (options.clear) {
    await clearRequests(options.cwd);
    if (options.json) envelope(deps, true, { cleared: true });
    else deps.log("Queue cleared.");
    return { exitCode: 0 };
  }

  const requests = await readRequests(options.cwd);

  if (options.json) {
    envelope(deps, true, { requests });
    return { exitCode: 0 };
  }

  if (requests.length === 0) {
    deps.log("No pending requests.");
    return { exitCode: 0 };
  }

  for (const request of requests) {
    deps.log(`  ${request.title}: ${request.intent}`);
    if (request.target !== null) deps.log(`    ${request.target}`);
  }
  deps.log("");
  deps.log("Run leglas requests --json to get the full prompts, then --clear when done.");
  return { exitCode: 0 };
}
