import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addLocalPreview,
  clearRequests,
  collectRequests,
  loadConfig,
  readLocalPreviews,
  type PendingRequest,
} from "@leglas/server";

import { ignoreEntry } from "./ignore.js";
import { interfaceUrl, recordedPort } from "./running.js";

import type { AddPreview } from "./args.js";

export type PreviewDeps = {
  log(line: string): void;
  error(line: string): void;
  fetch?: typeof fetch;
};

export type PreviewResult = { exitCode: number };

/** Every command prints one JSON envelope under --json, with a stable shape and exit code. */
type AddedPreview = {
  added: string;
  url?: string;
  local?: boolean;
  branch?: string;
  file?: string;
  note?: string;
  warning?: string;
  interfaceUrl?: string;
};

type EnvelopeBody =
  | { error: string | undefined }
  | AddedPreview
  | {
      previews: {
        title: string;
        url: string;
        note: string | null;
        tags: readonly string[];
        basedOn: string | null;
        askedFor: string | null;
        local: boolean;
        branch: string | null;
        file: string | null;
        interfaceUrl: string | null;
      }[];
      errors: string[];
    }
  | { cleared: number; pending: number }
  | { requests: PendingRequest[] };

function envelope(deps: PreviewDeps, ok: boolean, body: EnvelopeBody): void {
  deps.log(JSON.stringify({ ok, ...body }));
}

/**
 * Adding is local by default: exploration code lives in an ignored directory,
 * so a teammate must never get a config entry for something they don't have.
 * Sharing is a separate step.
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

  // The base direction was registered in the round the variant came from, so an
  // unknown title is a typo and is refused.
  if (options.preview.basedOn !== undefined) {
    const local = await readLocalPreviews(options.cwd);
    const titles = new Set([...shared, ...local.previews].map((preview) => preview.title));

    if (!titles.has(options.preview.basedOn)) {
      const error = `--based-on names ${JSON.stringify(options.preview.basedOn)}, which is not a registered direction. npx leglas list shows what exists.`;

      if (options.json) envelope(deps, false, { error });
      else deps.error(error);

      return { exitCode: 1 };
    }
  }

  const outcome = await addLocalPreview(
    options.cwd,
    {
      title: options.preview.title,
      url: options.preview.url,
      note: options.preview.note,
      tags: options.preview.tags,
      branch: options.preview.branch,
      file: options.preview.file,
      basedOn: options.preview.basedOn,
      askedFor: options.preview.askedFor,
    },
    shared,
  );

  if (!outcome.ok) {
    if (options.json) envelope(deps, false, { error: outcome.error });
    else deps.error(outcome.error ?? "Could not add the preview.");

    return { exitCode: 1 };
  }

  // The directory exists now, so ignore it before anything sweeps it into a
  // commit.
  await ensureIgnored(options.cwd);

  // A branch preview needs the config's devCommand to start its checkout. Said
  // at add time, when it's one edit away, not at boot, where it looks like a
  // broken preview.
  const needsDevCommand =
    options.preview.branch !== undefined && loaded.config?.devCommand === undefined;

  // A branch or file preview reaches the rail only after a restart, so a link
  // to it now would open on nothing.
  const joinsLive = options.preview.branch === undefined && options.preview.file === undefined;
  const port = joinsLive ? await recordedPort(options.cwd, deps.fetch ?? fetch) : null;
  const opens = port === null ? null : interfaceUrl(port, [options.preview.title]);

  if (options.json) {
    const added: AddedPreview = { added: options.preview.title };

    if (options.preview.url !== undefined) added.url = options.preview.url;
    added.local = true;

    if (options.preview.branch !== undefined) added.branch = options.preview.branch;

    if (options.preview.file !== undefined) added.file = options.preview.file;
    added.note =
      options.preview.branch === undefined && options.preview.file === undefined
        ? "A running interface picks this up within seconds."
        : "Restart Leglas to see this preview: branch checkouts and file mounts are built when Leglas starts.";

    if (needsDevCommand) {
      added.warning =
        "The config sets no devCommand, so Leglas cannot start this branch yet. Add devCommand (with {port}) to the config.";
    }

    if (opens !== null) added.interfaceUrl = opens;

    envelope(deps, true, added);
  } else {
    deps.log(
      `  added  ${options.preview.title}  ${options.preview.url ?? options.preview.file ?? ""}`,
    );

    if (opens !== null) deps.log(`  open   ${opens}`);
    deps.log("");

    if (needsDevCommand) {
      deps.log("  ! The config sets no devCommand, so Leglas cannot start this branch yet.");
      deps.log("    Add devCommand (with {port}) to the config.");
      deps.log("");
    }

    // Plain url previews join a running interface live; a branch needs its
    // checkout and a file its mount, both built at startup.
    if (options.preview.branch === undefined && options.preview.file === undefined) {
      deps.log("Local to this machine. A running interface picks it up within seconds.");
    } else {
      deps.log("Local to this machine. Restart Leglas to see it, or run npx leglas list.");
    }
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
    const port = await recordedPort(options.cwd, deps.fetch ?? fetch);

    envelope(deps, errors.length === 0, {
      // The whole record: a preview's note, tags and base direction are what
      // tell an agent why these are being compared.
      previews: previews.map((preview) => ({
        title: preview.title,
        url: preview.url,
        note: preview.note ?? null,
        tags: preview.tags,
        basedOn: preview.basedOn ?? null,
        askedFor: preview.askedFor ?? null,
        local: preview.local,
        branch: preview.branch ?? null,
        file: preview.file ?? null,
        interfaceUrl: port === null ? null : interfaceUrl(port, [preview.title]),
      })),
      errors,
    });

    return { exitCode: errors.length === 0 ? 0 : 1 };
  }

  if (previews.length === 0) {
    deps.log("No previews yet. Add one with npx leglas add, or list them in leglas.config.ts.");
  } else {
    const width = Math.max(...previews.map((preview) => preview.title.length));

    for (const preview of previews) {
      // A branch preview isn't in the user's tree, so say where it comes from.
      // A file preview's url is assigned at boot, so show its file.
      const source = preview.file ?? preview.url;
      const origin = preview.branch === undefined ? "" : `  (branch ${preview.branch})`;
      const scope = preview.local ? "  (local)" : "";
      deps.log(`  ${preview.title.padEnd(width)}  ${source}${origin}${scope}`);
    }
  }

  for (const error of errors) deps.error(`  ! ${error}`);

  return { exitCode: errors.length === 0 ? 0 : 1 };
}

/**
 * Hands pending requests to whoever asks: an agent polls this, acts on each
 * prompt and clears the queue. Leglas runs no model; the user's agent already
 * knows their conventions.
 */
export async function runRequests(
  options: { json: boolean; clear: boolean; cwd: string },
  deps: PreviewDeps,
): Promise<PreviewResult> {
  if (options.clear) {
    const { cleared, pending } = await clearRequests(options.cwd);

    if (options.json) envelope(deps, true, { cleared, pending });
    else {
      deps.log(cleared === 1 ? "Cleared 1 request." : `Cleared ${cleared} requests.`);

      // The case an agent would miss: it asked to finish and more is already
      // waiting.
      if (pending > 0) {
        deps.log(
          `${pending} arrived while you worked. Run npx leglas requests to collect ${pending === 1 ? "it" : "them"}.`,
        );
      }
    }

    return { exitCode: 0 };
  }

  const requests = await collectRequests(options.cwd);

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
  deps.log("Run npx leglas requests --json to get the full prompts, then --clear when done.");

  return { exitCode: 0 };
}
