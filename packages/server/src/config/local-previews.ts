import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeConfig, type Preview } from "./config.js";

import { isString, parseJson, type JsonValue, type JsonRecord } from "../json.js";

/**
 * Local previews live with the other machine-local state, so exploration can't
 * reach a teammate; the committed config stays the only shared description.
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
  /** The direction this preview is a variant of; the rail groups the family. */
  basedOn?: string | undefined;
  /** The change that was asked for, in the words that were typed. */
  askedFor?: string | undefined;
};

export async function readLocalPreviews(
  cwd: string,
): Promise<{ previews: LocalPreview[]; errors: string[] }> {
  const path = join(cwd, LOCAL_PREVIEWS_PATH);

  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && isString(error.code) ? error.code : null;

    if (code === "ENOENT") {
      // Never added anything here; nothing to report.
      return { previews: [], errors: [] };
    }

    return {
      previews: [],
      errors: [
        `${LOCAL_PREVIEWS_PATH} could not be read (${code ?? "unknown error"}). Check its permissions and file type; nothing shared is lost.`,
      ],
    };
  }

  let parsed: JsonValue;

  try {
    parsed = parseJson(raw);
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

  // Validated like the config, so a hand-edited file gets no weaker check. Only
  // the branch-devCommand pairing is relaxed, since devCommand lives in the
  // shared config and is checked where the two merge.
  const result = normalizeConfig(parsed, { requireDevCommand: false });

  if (result.config === null) {
    return {
      previews: [],
      errors: result.errors.map((error) => `${LOCAL_PREVIEWS_PATH}: ${error}`),
    };
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

  const taken = [...shared, ...existing.previews].some((preview) => preview.title === input.title);

  if (taken) {
    return {
      ok: false,
      error: `A preview called ${JSON.stringify(input.title)} already exists. Titles identify previews, so they have to be unique.`,
    };
  }

  const candidate: JsonRecord = { title: input.title };

  if (input.url !== undefined) candidate.url = input.url;

  if (input.note !== undefined) candidate.note = input.note;

  if (input.tags !== undefined) candidate.tags = [...input.tags];

  if (input.branch !== undefined) candidate.branch = input.branch;

  if (input.file !== undefined) candidate.file = input.file;

  if (input.basedOn !== undefined) candidate.basedOn = input.basedOn;

  if (input.askedFor !== undefined) candidate.askedFor = input.askedFor;

  const check = normalizeConfig({ previews: [candidate] }, { requireDevCommand: false });

  if (check.config === null) {
    return { ok: false, error: check.errors.join(" ") };
  }

  const path = join(cwd, LOCAL_PREVIEWS_PATH);
  await mkdir(dirname(path), { recursive: true });
  // Indented so the file reads well when someone wonders where a preview came
  // from.
  await writeFile(
    path,
    `${JSON.stringify({ previews: [...existing.previews.map(toStored), candidate] }, null, 2)}\n`,
    "utf8",
  );

  return { ok: true };
}

/**
 * Reading fills an empty url placeholder for a file preview; writing it back
 * would claim a url and a file at once and fail the next read, so it's dropped.
 */
function toStored(preview: LocalPreview): Omit<LocalPreview, "local" | "url"> & { url?: string } {
  const { local: _local, url, ...rest } = preview;

  return preview.file !== undefined && url === "" ? rest : { url, ...rest };
}

/**
 * Forgets local previews by title, when an exploration ends and its directions
 * leave the rail with their code.
 */
export async function dropLocalPreviews(cwd: string, titles: readonly string[]): Promise<number> {
  const existing = await readLocalPreviews(cwd);
  const keep = existing.previews.filter((preview) => !titles.includes(preview.title));

  if (keep.length === existing.previews.length) return 0;

  const path = join(cwd, LOCAL_PREVIEWS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ previews: keep.map(toStored) }, null, 2)}\n`, "utf8");

  return existing.previews.length - keep.length;
}
