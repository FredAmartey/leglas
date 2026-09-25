import { bodyOf, isJsonObject, isNumber, isString, type JsonValue } from "./json.js";
import { findLeglas } from "./running.js";

export type ExploreBuildOptions = {
  surface: string;
  brief: string;
  count: number;
  json: boolean;
  cwd: string;
  port: number | null;
};

export type ExploreBuildDeps = {
  log(line: string): void;
  error(line: string): void;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type Slot = {
  key: string;
  title: string;
  state: string;
  failure: { message: string } | null;
  fixed: boolean;
};

type Job = {
  id: string;
  state: string;
  error: string | null;
  slots: Slot[];
  startedAt: number;
  endedAt: number | null;
};

/** How often the command looks at the job. The builds take tens of seconds, so a second is plenty. */
const POLL_MS = 1000;

/** Longer than any job can run: each build has its own five-minute ceiling inside Leglas. */
const WAIT_MS = 20 * 60_000;

function readJob(value: JsonValue | undefined): Job | null {
  if (value === undefined || !isJsonObject(value)) return null;
  const { id, state, slots, error, startedAt, endedAt } = value;

  if (!isString(id) || !isString(state) || !Array.isArray(slots)) return null;

  const read: Slot[] = slots.flatMap((entry) => {
    if (
      !isJsonObject(entry) ||
      !isString(entry.key) ||
      !isString(entry.title) ||
      !isString(entry.state)
    )
      return [];

    const failure =
      entry.failure === undefined || entry.failure === null || !isJsonObject(entry.failure)
        ? null
        : entry.failure;

    return [
      {
        key: entry.key,
        title: entry.title,
        state: entry.state,
        failure:
          failure !== null && isString(failure.message) ? { message: failure.message } : null,
        fixed: entry.fixed === true,
      },
    ];
  });

  return {
    id,
    state,
    error: isString(error) ? error : null,
    slots: read,
    startedAt: isNumber(startedAt) ? startedAt : Date.now(),
    endedAt: isNumber(endedAt) ? endedAt : null,
  };
}

/**
 * Build a set of directions with the configured agent and wait for it.
 *
 * The work happens in the running Leglas, which owns the switch file, the
 * rail and the renders; this command starts it, reports each direction as it
 * lands and exits 0 only when every one is ready. Leaving it early does not
 * stop the builds, which the interface can still show and stop.
 */
export async function runExploreBuild(
  options: ExploreBuildOptions,
  deps: ExploreBuildDeps,
): Promise<{ exitCode: number }> {
  const request = deps.fetch ?? fetch;

  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  const found = await findLeglas(options.cwd, options.port, request);

  if (!found.ok) return fail(found.error);
  const base = `http://127.0.0.1:${found.port}/leglas/api/generate`;

  let started: JsonValue;

  try {
    started = await bodyOf(
      await request(base, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${found.port}` },
        body: JSON.stringify({
          surface: options.surface,
          brief: options.brief,
          count: options.count,
        }),
      }),
    );
  } catch {
    return fail("Leglas did not answer. Is it still running?");
  }

  const answer = isJsonObject(started) ? started : null;
  const first = readJob(answer?.job);

  if (answer?.ok !== true || first === null) {
    return fail(isString(answer?.error) ? answer.error : "Leglas could not start the build.");
  }

  if (!options.json) deps.log(`Planning ${options.count} directions for the ${options.surface}…`);

  const said = new Map<string, string>();
  let announced = false;
  let job: Job = first;
  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let listed: JsonValue;

    try {
      listed = await bodyOf(await request(base));
    } catch {
      return fail("Leglas stopped answering while the directions were being built.");
    }

    const jobs = isJsonObject(listed) ? listed.jobs : undefined;

    const latest = Array.isArray(jobs)
      ? jobs.map(readJob).find((candidate) => candidate?.id === first.id)
      : undefined;

    if (latest === undefined || latest === null) continue;
    job = latest;

    if (!options.json && !announced && job.slots.length > 0) {
      announced = true;
      deps.log(
        `On the rail: ${job.slots.map((slot) => slot.title).join(", ")}. Building them now.`,
      );
    }

    for (const slot of job.slots) {
      if (options.json || said.get(slot.key) === slot.state) continue;
      said.set(slot.key, slot.state);

      if (slot.state === "ready")
        deps.log(
          `Ready: ${slot.title}${slot.fixed ? " (its first version did not render; fixed)" : ""}`,
        );
      else if (slot.state === "failed")
        deps.log(`Failed: ${slot.title}. ${slot.failure?.message ?? ""}`.trim());
      else if (slot.state === "stopped") deps.log(`Stopped: ${slot.title}`);
    }

    if (job.state === "done" || job.state === "failed" || job.state === "stopped") break;
  }

  const ready = job.slots.filter((slot) => slot.state === "ready").length;
  const ok = job.state === "done" && ready === job.slots.length && ready > 0;

  if (options.json) {
    deps.log(JSON.stringify({ ok, job }));

    return { exitCode: ok ? 0 : 1 };
  }

  if (job.state === "failed") return fail(job.error ?? "The build failed.");
  const seconds = job.endedAt === null ? null : Math.round((job.endedAt - job.startedAt) / 1000);

  deps.log(
    `${ready} of ${job.slots.length} directions ready${seconds === null ? "" : ` in ${seconds} s`}. Compare them in the interface, or keep one with leglas keep.`,
  );

  return { exitCode: ok ? 0 : 1 };
}
