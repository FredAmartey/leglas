import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Concept } from "./prompts.js";

import { isJsonRecord, isString, parseJson } from "../json.js";

/**
 * One folder per set of directions: `set.json` for what the engine did,
 * `events.jsonl` for what was done to the set after, and a picture of each
 * attempt's last render. The events are a log of their own because the CLI
 * adds to it while the server may be rewriting `set.json`.
 */
export const RECORDS_DIR = ".leglas/generations";

/** Sets kept on disk. Older ones go when a new set starts. */
export const KEPT_RECORDS = 100;

export type RunRecord = {
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  error: string | null;
  /** The agent's last message. */
  result: string | null;
  /** The run's last lines, kept only when it failed. */
  tail: string[];
};

export type AttemptRecord = {
  attempt: number;
  cause: "plan" | "retry" | "replace";
  title: string;
  idea: string;
  /** The run that asked for a new idea, for a replace. */
  ideaRun: RunRecord | null;
  build: RunRecord | null;
  /** Every render check, in order: what the page reported and the text in trouble on it. */
  renders: { at: number; errors: string[]; layout: string[] }[];
  fix: RunRecord | null;
  state: string;
  failure: { code: string; message: string } | null;
  fixed: boolean;
  layout: string[];
  /** The last render, relative to the set's folder. */
  picture: string | null;
};

export type SetRecord = {
  version: 1;
  id: string;
  surface: string;
  brief: string;
  count: number;
  agent: string;
  /** The CLI arguments of a build, without its prompt: the model and effort show there. */
  args: string[];
  basedOn: { title: string; key: string; set: string | null } | null;
  state: string;
  error: string | null;
  startedAt: number;
  plannedAt: number | null;
  endedAt: number | null;
  plan: (RunRecord & { concepts: Concept[] }) | null;
  directions: { key: string; file: string; attempts: AttemptRecord[] }[];
};

export type RecordEvent = {
  at: number;
  kind: "stop" | "retry" | "replace" | "more-like" | "keep" | "remove";
  /** The direction's key, or null for the whole set. */
  direction: string | null;
  /** Anything that says more: the set a "more like" started, the file a keep became. */
  detail?: string;
};

/** Newest first, by the start time in each id (`gen-<base 36 ms>`). */
async function recordIds(cwd: string): Promise<string[]> {
  const names = await readdir(join(cwd, RECORDS_DIR)).catch(() => []);
  const started = (id: string): number => Number.parseInt(id.slice(4), 36);

  return names
    .filter((name) => /^gen-[a-z0-9]+$/.test(name))
    .sort((a, b) => started(b) - started(a));
}

/** Each direction in a set's record by key, with the title its latest attempt went by. */
async function directionsOf(
  cwd: string,
  id: string,
): Promise<{ key: string; title: string | null }[]> {
  let parsed;

  try {
    parsed = parseJson(await readFile(join(cwd, RECORDS_DIR, id, "set.json"), "utf8"));
  } catch {
    return [];
  }

  if (!isJsonRecord(parsed) || !Array.isArray(parsed.directions)) return [];

  return parsed.directions.flatMap((direction) => {
    if (!isJsonRecord(direction) || !isString(direction.key)) return [];
    const attempts = Array.isArray(direction.attempts) ? direction.attempts : [];
    const last = attempts.at(-1);

    return [
      {
        key: direction.key,
        title: isJsonRecord(last) && isString(last.title) ? last.title : null,
      },
    ];
  });
}

/** Adds one event to a set's log. Appends are whole lines, so two writers never tear one. */
async function appendEvent(cwd: string, id: string, event: RecordEvent): Promise<void> {
  const dir = join(cwd, RECORDS_DIR, id);

  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * For each title, the newest set whose direction goes by it now, with that
 * direction's key. A title from a set built with records off can match an
 * older recorded direction of the same name, long gone from the rail.
 */
async function setsOfTitles(
  cwd: string,
  titles: readonly string[],
): Promise<Map<string, { id: string; key: string }>> {
  const found = new Map<string, { id: string; key: string }>();

  for (const id of await recordIds(cwd)) {
    if (found.size === titles.length) break;

    for (const direction of await directionsOf(cwd, id)) {
      const title = direction.title;

      if (title !== null && titles.includes(title) && !found.has(title))
        found.set(title, { id, key: direction.key });
    }
  }

  return found;
}

/** The newest set that built the direction with `key`. */
export async function setOfKey(cwd: string, key: string): Promise<string | null> {
  for (const id of await recordIds(cwd)) {
    if ((await directionsOf(cwd, id)).some((each) => each.key === key)) return id;
  }

  return null;
}

/**
 * Notes what happened to generated directions outside the engine: a keep or
 * a remove. Titles no kept record built are skipped, and so is any failure,
 * since the record never gets in the way of the work.
 */
export async function noteDirections(
  cwd: string,
  titles: readonly string[],
  kind: "keep" | "remove",
  detail?: string,
): Promise<void> {
  const unique = [...new Set(titles)];
  const found = await setsOfTitles(cwd, unique).catch(() => new Map<string, never>());

  for (const title of unique) {
    const set = found.get(title);

    if (set === undefined) continue;
    const event: RecordEvent = { at: Date.now(), kind, direction: set.key };

    if (detail !== undefined) event.detail = detail;
    await appendEvent(cwd, set.id, event).catch(() => {});
  }
}

export type Records = {
  /** Makes room for a new set: only the newest `KEPT_RECORDS - 1` stay. */
  prune(): Promise<void>;
  /** Queues a write of the set's record; writes of one set never overlap. */
  save(record: SetRecord): void;
  /** Queues a picture beside the set's record. */
  picture(id: string, name: string, image: Buffer): void;
  event(id: string, event: RecordEvent): void;
  /** Waits for every queued write. */
  flush(): Promise<void>;
};

export function createRecords(cwd: string): Records {
  let queue: Promise<void> = Promise.resolve();

  // One chain for everything: the order writes were asked for is the order they land.
  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch(() => {});
  };

  return {
    async prune() {
      const ids = await recordIds(cwd);

      for (const id of ids.slice(KEPT_RECORDS - 1)) {
        await rm(join(cwd, RECORDS_DIR, id), { recursive: true, force: true }).catch(() => {});
      }
    },

    save(record) {
      // Serialised now, so a later change to the set can't reach an earlier write.
      const body = `${JSON.stringify(record, null, 2)}\n`;

      enqueue(async () => {
        const dir = join(cwd, RECORDS_DIR, record.id);
        const path = join(dir, "set.json");
        const temporary = `${path}.${randomUUID()}.tmp`;

        await mkdir(dir, { recursive: true });
        await writeFile(temporary, body, "utf8");
        await rename(temporary, path).catch(async (cause: unknown) => {
          await rm(temporary, { force: true }).catch(() => {});
          throw cause;
        });
      });
    },

    picture(id, name, image) {
      enqueue(async () => {
        const dir = join(cwd, RECORDS_DIR, id);

        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), image);
      });
    },

    event(id, event) {
      enqueue(() => appendEvent(cwd, id, event));
    },

    flush: () => queue,
  };
}
