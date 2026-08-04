import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeConfig, type Preview } from "./config.js";

/**
 * Locally added previews live beside the other machine-local artefacts, so
 * exploration cannot reach a teammate by accident. The committed config stays
 * the only shared description of a project.
 */
export const LOCAL_PREVIEWS_PATH = ".leglas/previews.json";

export type LocalPreview = Preview & { local: true };

export type AddInput = {
  title: string;
  /** Absent for a file preview, whose url Leglas assigns at boot. */
  url?: string | undefined;
  note?: string | undefined;
  tags?: readonly string[] | undefined;
  /** Back the preview with a checkout of this branch instead of the running server. */
  branch?: string | undefined;
  /** A project-relative HTML file for Leglas to serve itself. */
  file?: string | undefined;
  /** The direction this preview is a shade of; the rail groups the family. */
  basedOn?: string | undefined;
};

export async function readLocalPreviews(
  cwd: string,
): Promise<{ previews: LocalPreview[]; errors: string[] }> {
  const path = join(cwd, LOCAL_PREVIEWS_PATH);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Never added anything here. Not a problem, and not worth reporting.
    return { previews: [], errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      previews: [],
      errors: [
        `${LOCAL_PREVIEWS_PATH} is not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }). Delete it to start over; nothing shared is lost.`,
      ],
    };
  }

  // Validated exactly as the config is, so a hand-edited file cannot slip
  // through a weaker check than the one the shared file gets. Only the
  // branch-devCommand coupling is relaxed: devCommand lives in the shared
  // config, and whether it is set there is checked where the two merge.
  const result = normalizeConfig(parsed, { requireDevCommand: false });
  if (result.config === null) {
    return { previews: [], errors: result.errors.map((error) => `${LOCAL_PREVIEWS_PATH}: ${error}`) };
  }

  return {
    previews: result.config.previews.map((preview) => ({ ...preview, local: true as const })),
    errors: [],
  };
}

export async function addLocalPreview(
  cwd: string,
  input: AddInput,
  shared: readonly Preview[],
): Promise<{ ok: boolean; error?: string }> {
  const existing = await readLocalPreviews(cwd);
  if (existing.errors.length > 0) {
    return { ok: false, error: existing.errors.join(" ") };
  }

  const taken = [...shared, ...existing.previews].some(
    (preview) => preview.title === input.title,
  );
  if (taken) {
    return {
      ok: false,
      error: `A preview called ${JSON.stringify(input.title)} already exists. Titles identify previews, so they have to be unique.`,
    };
  }

  const candidate = {
    title: input.title,
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.basedOn === undefined ? {} : { basedOn: input.basedOn }),
  };

  const check = normalizeConfig({ previews: [candidate] }, { requireDevCommand: false });
  if (check.config === null) {
    return { ok: false, error: check.errors.join(" ") };
  }

  const path = join(cwd, LOCAL_PREVIEWS_PATH);
  await mkdir(dirname(path), { recursive: true });
  // Indented because this file is meant to be openable: someone will read it
  // when they wonder where a preview came from.
  await writeFile(
    path,
    `${JSON.stringify(
      { previews: [...existing.previews.map(toStored), candidate] },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { ok: true };
}

/**
 * A file preview declares no url; validation fills an empty placeholder when
 * reading. Writing that placeholder back would make the entry claim a url and
 * a file at once and fail its next read, so it is dropped on the way out.
 */
function toStored(preview: LocalPreview): Record<string, unknown> {
  const { local: _local, url, ...rest } = preview;
  return preview.file !== undefined && url === "" ? rest : { url, ...rest };
}

/**
 * Forget locally added previews by title.
 *
 * Used when an exploration ends: the directions of that surface are no longer
 * alternatives, so they leave the rail with the code they described.
 */
export async function dropLocalPreviews(cwd: string, titles: readonly string[]): Promise<number> {
  const existing = await readLocalPreviews(cwd);
  const keep = existing.previews.filter((preview) => !titles.includes(preview.title));
  if (keep.length === existing.previews.length) return 0;

  const path = join(cwd, LOCAL_PREVIEWS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ previews: keep.map(toStored) }, null, 2)}\n`,
    "utf8",
  );
  return existing.previews.length - keep.length;
}
