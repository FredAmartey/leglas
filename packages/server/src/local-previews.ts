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
  url: string;
  note?: string | undefined;
  tags?: readonly string[] | undefined;
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
  // through a weaker check than the one the shared file gets.
  const result = normalizeConfig(parsed);
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
    url: input.url,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  };

  const check = normalizeConfig({ previews: [candidate] });
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
      {
        previews: [
          ...existing.previews.map(({ local: _local, ...preview }) => preview),
          candidate,
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { ok: true };
}
