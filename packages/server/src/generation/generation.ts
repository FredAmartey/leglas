import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildArgs, planArgs, resultText } from "./claude.js";
import { factsBlock, readProjectFacts } from "./facts.js";
import {
  buildPrompt,
  fixPrompt,
  parseConcepts,
  pascal,
  planPrompt,
  replacePrompt,
  type Concept,
} from "./prompts.js";
import { addSlots, directionKeys, findSwitch, isFile, placeholderSource } from "./switch-file.js";

import { agentEnvironment, type SavedAgentChoice } from "../agents/agents.js";
import { classifyFailure, type FailureCode } from "../agents/failure.js";
import { ownGroup, signalTree } from "../agents/process-tree.js";
import type { RunnerChild, RunnerSpawn } from "../agents/runner.js";
import type { AddInput } from "../config/local-previews.js";
import { isJsonRecord, isString, parseJson } from "../json.js";

export const MAX_DIRECTIONS = 6;

/**
 * The longest a build may run. Medium-effort builds took 36 to 68 seconds in
 * measurement, so five minutes means something went wrong, and ending it
 * keeps the promise that nobody waits half an hour for a draft.
 */
export const BUILD_DEADLINE_MS = 5 * 60_000;

const PLAN_DEADLINE_MS = 2 * 60_000;

const FIX_DEADLINE_MS = 3 * 60_000;

const KILL_GRACE_MS = 5000;

/** Jobs kept for the interface after they finish. */
const KEPT_JOBS = 5;

export type SlotState = "building" | "checking" | "ready" | "failed" | "stopped";

export type GenerationFailure = {
  code:
    | FailureCode
    | "too-slow"
    | "not-written"
    | "broken"
    | "unreadable-plan"
    | "same-failure"
    | "unexpected";
  message: string;
};

export type GenerationSlot = {
  key: string;
  title: string;
  idea: string;
  /** Project-relative path of the direction's file. */
  file: string;
  state: SlotState;
  startedAt: number | null;
  endedAt: number | null;
  failure: GenerationFailure | null;
  /** Whether the page failed to render once and a fix run repaired it. */
  fixed: boolean;
};

export type GenerationJob = {
  id: string;
  surface: string;
  brief: string;
  count: number;
  state: "planning" | "building" | "done" | "failed" | "stopped";
  startedAt: number;
  plannedAt: number | null;
  endedAt: number | null;
  error: string | null;
  slots: GenerationSlot[];
};

export type GenerationRequest = {
  surface: string;
  brief: string;
  count: number;
  agent: SavedAgentChoice;
};

export type GenerationDeps = {
  cwd: string;
  /** Injected by tests; the default spawns the agent CLI with the environment the runner gives it. */
  spawn?: RunnerSpawn;
  /** Renders a registered direction by title; null when nothing could render it. */
  render(title: string): Promise<{ errors: readonly string[] } | null>;
  register(input: AddInput): Promise<{ ok: boolean; error?: string }>;
  unregister(titles: readonly string[]): Promise<void>;
  /** Every preview title already in use, shared and local. */
  titles(): Promise<ReadonlySet<string>>;
  onChange(): void;
  now?: () => number;
};

export type Generations = {
  start(
    request: GenerationRequest,
  ): Promise<{ ok: true; job: GenerationJob } | { ok: false; error: string }>;
  snapshot(): GenerationJob[];
  /** Stop one direction, or the whole job when no slot is named. */
  stop(id: string, slot?: string): Promise<boolean>;
  retry(id: string, slot: string): boolean;
  replace(id: string, slot: string): boolean;
  close(): Promise<void>;
};

type Outcome = { code: number | null; lines: string[]; error: string | null; timedOut: boolean };

/** A run of the agent CLI. `stop` resolves once the process is gone, escalating to SIGKILL if it lingers. */
type Run = { done: Promise<Outcome>; stop(): Promise<void> };

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref?.();
  });
}

type Live = {
  job: GenerationJob;
  concepts: Map<string, Concept>;
  runs: Map<string, Run>;
  plan: Run | null;
  switchPath: string;
  facts: string | null;
  stack: string;
  /** The attempt each slot's work currently belongs to; see `begin`. */
  attempts: Map<string, number>;
  /** Work still running after the call that started it answered; see `detach`. */
  pending: Set<Promise<void>>;
};

export function surfaceSlug(surface: string): string {
  return surface
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function stackOf(cwd: string, switchPath: string): Promise<string> {
  let deps: Record<string, string> = {};

  try {
    const pkg = parseJson(await readFile(join(cwd, "package.json"), "utf8"));

    if (isJsonRecord(pkg)) {
      for (const group of [pkg.devDependencies, pkg.dependencies]) {
        if (!isJsonRecord(group)) continue;

        for (const [name, version] of Object.entries(group)) {
          if (isString(version)) deps[name] = version;
        }
      }
    }
  } catch {
    deps = {};
  }

  const major = /\d+/.exec(deps.react ?? "")?.[0];
  const react = major === undefined ? "React" : `React ${major}`;
  const typescript = switchPath.endsWith(".tsx") ? " and TypeScript" : "";

  if (deps.next !== undefined) return `a Next.js app with ${react}${typescript}`;

  if (deps.vite !== undefined) return `a Vite app with ${react}${typescript}`;

  return `an app with ${react}${typescript}`;
}

function copy(job: GenerationJob): GenerationJob {
  return {
    ...job,
    slots: job.slots.map((slot) => ({
      ...slot,
      failure: slot.failure === null ? null : { ...slot.failure },
    })),
  };
}

export function createGenerations(deps: GenerationDeps): Generations {
  const now = deps.now ?? Date.now;

  const spawn: RunnerSpawn =
    deps.spawn ??
    ((command, args, options) => nodeSpawn(command, args, { ...options, env: agentEnvironment() }));

  const lives: Live[] = [];
  let closed = false;

  const changed = (): void => deps.onChange();

  // Registration rewrites one file; queued, two writers can never lose each other's entries.
  let registry: Promise<unknown> = Promise.resolve();

  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = registry.then(task, task);
    registry = next.catch(() => {});

    return next;
  };

  const run = (args: string[], deadlineMs: number): Run => {
    const lines: string[] = [];
    let timedOut = false;
    let child: RunnerChild | null = null;

    const done = new Promise<Outcome>((resolve) => {
      // Work that was already on its way when Leglas closed ends here, before any process starts.
      if (closed) {
        resolve({ code: null, lines, error: "Leglas is closing.", timedOut });

        return;
      }

      try {
        child = spawn("claude", args, {
          cwd: deps.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          ...ownGroup(),
        });
      } catch (error) {
        resolve({
          code: null,
          lines,
          error: error instanceof Error ? error.message : String(error),
          timedOut,
        });

        return;
      }

      let buffered = "";

      const take = (chunk: string | Buffer): void => {
        buffered += chunk.toString();
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        lines.push(...parts);
      };

      child.stdout.on("data", take);
      child.stderr.on("data", take);

      const deadline = setTimeout(() => {
        timedOut = true;

        if (child !== null) signalTree(child, "SIGTERM");
        setTimeout(() => {
          if (child !== null) signalTree(child, "SIGKILL");
        }, KILL_GRACE_MS).unref?.();
      }, deadlineMs);

      deadline.unref?.();
      child.once("error", (error) => {
        clearTimeout(deadline);
        resolve({ code: null, lines, error: error.message, timedOut });
      });
      child.once("close", (code) => {
        clearTimeout(deadline);

        if (buffered !== "") lines.push(buffered);
        resolve({ code, lines, error: null, timedOut });
      });
    });

    return {
      done,
      stop: async () => {
        if (child === null) return;
        signalTree(child, "SIGTERM");

        const exited = await Promise.race([
          done.then(() => true),
          wait(KILL_GRACE_MS).then(() => false),
        ]);

        if (!exited && child !== null) {
          signalTree(child, "SIGKILL");
          await Promise.race([done, wait(KILL_GRACE_MS)]);
        }
      },
    };
  };

  const failureOf = (outcome: Outcome): GenerationFailure =>
    classifyFailure({
      agent: "Claude",
      error: outcome.error,
      exitCode: outcome.code,
      lines: outcome.lines.slice(-40),
    });

  const settle = (live: Live): void => {
    const { job } = live;

    if (job.state === "planning" || job.state === "failed") return;

    if (job.slots.some((slot) => slot.state === "building" || slot.state === "checking")) {
      job.state = "building";

      return;
    }

    job.state = job.slots.every((slot) => slot.state === "stopped") ? "stopped" : "done";
    job.endedAt = now();
  };

  const restore = async (slot: GenerationSlot): Promise<void> => {
    await writeFile(join(deps.cwd, slot.file), placeholderSource(pascal(slot.key)), "utf8").catch(
      () => {},
    );
  };

  /**
   * Every piece of work on a slot holds the attempt it started under. A stop,
   * a retry or a replace starts a new one, and work still running for an
   * older attempt finds out at its next step and leaves the slot alone. A
   * state string cannot do this: a retry sets "building" again, which is
   * exactly what stale work expects to see.
   */
  const begin = (live: Live, slot: GenerationSlot): number => {
    const attempt = (live.attempts.get(slot.key) ?? 0) + 1;
    live.attempts.set(slot.key, attempt);

    return attempt;
  };

  const owns = (live: Live, slot: GenerationSlot, attempt: number): boolean =>
    live.attempts.get(slot.key) === attempt;

  /** `work`, with any error it ends in handed to `onError` as a message. */
  const guarded = (work: Promise<void>, onError: (message: string) => void): Promise<void> =>
    work.catch((error) => onError(error instanceof Error ? error.message : String(error)));

  /**
   * Keep work that carries on after the call that started it has answered.
   * A stop or close waits for it, since a write cut off by the process
   * exiting leaves a file half-written, and its error goes to `onError`
   * instead of taking the server down.
   */
  const detach = (live: Live, work: Promise<void>, onError: (message: string) => void): void => {
    const kept = guarded(work, onError);

    live.pending.add(kept);
    void kept.then(() => live.pending.delete(kept));
  };

  /** Wait for everything a job has detached, including work detached meanwhile. */
  const drain = async (live: Live): Promise<void> => {
    while (live.pending.size > 0) await Promise.all(live.pending);
  };

  /**
   * Take a slot back from its run: the process is gone before the
   * placeholder returns, so nothing it writes on the way out survives, and
   * the run stays registered until then so no retry can start beside it.
   */
  const release = async (live: Live, slot: GenerationSlot): Promise<void> => {
    const running = live.runs.get(slot.key);

    await running?.stop();
    await restore(slot);

    // A retry accepted meanwhile has its own run, which must stay stoppable.
    if (running !== undefined && live.runs.get(slot.key) === running) live.runs.delete(slot.key);
  };

  const fail = (live: Live, slot: GenerationSlot, failure: GenerationFailure): void => {
    slot.state = "failed";
    slot.failure = failure;
    slot.endedAt = now();

    // Two builds failing the same way means the rest will too; stop spending the person's plan on them.
    const same = live.job.slots.filter((other) => other.failure?.code === failure.code).length;

    if (same >= 2) {
      for (const other of live.job.slots) {
        if (other.state !== "building" && other.state !== "checking") continue;
        begin(live, other);
        other.state = "stopped";
        other.failure = {
          code: "same-failure",
          message: `Stopped after two directions failed the same way: ${failure.message}`,
        };
        other.endedAt = now();
        detach(live, release(live, other), () => {});
      }
    }
  };

  /** An error nothing planned for, in work on a slot: the slot shows it, if the slot is still that work's. */
  const lost = (live: Live, slot: GenerationSlot, attempt: number, message: string): void => {
    if (!owns(live, slot, attempt)) return;
    fail(live, slot, { code: "unexpected", message });
    settle(live);
    changed();
  };

  const build = async (live: Live, slot: GenerationSlot, attempt: number): Promise<void> => {
    const concept = live.concepts.get(slot.key);

    // Stopped or replaced between being accepted and starting: the newer attempt stands.
    if (concept === undefined || !owns(live, slot, attempt)) return;
    slot.state = "building";
    slot.startedAt = now();
    slot.endedAt = null;
    slot.failure = null;
    slot.fixed = false;
    changed();

    const others = [...live.concepts.values()].filter((other) => other !== concept);

    const prompt = buildPrompt({
      surface: live.job.surface,
      brief: live.job.brief,
      concept,
      others,
      file: slot.file,
      name: pascal(slot.key),
      stack: live.stack,
      facts: live.facts ?? "",
    });

    const building = run(buildArgs(prompt), BUILD_DEADLINE_MS);
    live.runs.set(slot.key, building);
    const outcome = await building.done;

    // A stop or a newer attempt took the slot over while this run was ending.
    if (!owns(live, slot, attempt)) return;

    if (live.runs.get(slot.key) === building) live.runs.delete(slot.key);
    const written = await readFile(join(deps.cwd, slot.file), "utf8").catch(() => "");

    if (!owns(live, slot, attempt)) return;

    if (outcome.timedOut) {
      fail(live, slot, {
        code: "too-slow",
        message: `The build took longer than ${BUILD_DEADLINE_MS / 60_000} minutes, so Leglas stopped it.`,
      });
    } else if (outcome.error !== null || outcome.code !== 0) {
      fail(live, slot, failureOf(outcome));
    } else if (written === placeholderSource(pascal(slot.key))) {
      fail(live, slot, {
        code: "not-written",
        message: "The build finished without writing its file.",
      });
    } else {
      slot.state = "checking";
      changed();
      await check(live, slot, attempt);
    }

    settle(live);
    changed();
  };

  /**
   * Render the direction before calling it ready. One measured build in six
   * wrote broken JSX first; a page that reports errors gets one fix run
   * carrying the error, and still broken means failed, never a broken
   * direction presented as done.
   */
  const check = async (live: Live, slot: GenerationSlot, attempt: number): Promise<void> => {
    let report = await deps.render(slot.title);

    // A stop, or a stop and a retry, can land while the page renders.
    if (!owns(live, slot, attempt)) return;

    if (report !== null && report.errors.length > 0) {
      const fixing = run(
        buildArgs(fixPrompt({ file: slot.file, errors: report.errors })),
        FIX_DEADLINE_MS,
      );

      live.runs.set(slot.key, fixing);
      const outcome = await fixing.done;

      if (!owns(live, slot, attempt)) return;

      if (live.runs.get(slot.key) === fixing) live.runs.delete(slot.key);

      if (outcome.timedOut || outcome.error !== null || outcome.code !== 0) {
        fail(
          live,
          slot,
          outcome.timedOut
            ? { code: "too-slow", message: "The fix took too long, so Leglas stopped it." }
            : failureOf(outcome),
        );

        return;
      }

      slot.fixed = true;
      report = await deps.render(slot.title);

      if (!owns(live, slot, attempt)) return;

      if (report !== null && report.errors.length > 0) {
        fail(live, slot, {
          code: "broken",
          message: `The page still reports: ${report.errors[0] ?? ""}`,
        });

        return;
      }
    }

    slot.state = "ready";
    slot.endedAt = now();
  };

  const freeTitle = (title: string, taken: Set<string>): string => {
    let candidate = title;

    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${title} ${suffix}`;
    taken.add(candidate);

    return candidate;
  };

  const plan = async (live: Live, existing: readonly string[]): Promise<void> => {
    const { job } = live;

    const planning = run(
      planArgs(planPrompt({ surface: job.surface, brief: job.brief, count: job.count, existing })),
      PLAN_DEADLINE_MS,
    );

    live.plan = planning;
    const outcome = await planning.done;
    live.plan = null;

    if (job.state !== "planning") return;

    if (outcome.timedOut || outcome.error !== null || outcome.code !== 0) {
      job.state = "failed";
      job.error = outcome.timedOut
        ? "Planning took too long, so Leglas stopped it."
        : failureOf(outcome).message;
      job.endedAt = now();
      changed();

      return;
    }

    let concepts: Concept[];

    try {
      concepts = parseConcepts(resultText(outcome.lines) ?? "", job.count);
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.endedAt = now();
      changed();

      return;
    }

    live.facts = factsBlock(await readProjectFacts(deps.cwd, live.switchPath), job.surface);
    const slug = surfaceSlug(job.surface);
    const keys = new Set(existing);
    const titles = new Set(await deps.titles());
    const folder = dirname(live.switchPath);
    // Slots join the job only once they are on the rail, so whoever reads the job never sees a direction the rail lacks.
    const slots: GenerationSlot[] = [];

    const extension = live.switchPath.endsWith(".jsx") ? "jsx" : "tsx";

    // A key is free only when neither the switch nor the folder has it: a
    // switch kept with the person's components sits beside files that are
    // not directions, and a placeholder must never replace one of them.
    const taken = async (key: string): Promise<boolean> =>
      keys.has(key) || (await isFile(join(deps.cwd, folder, `${key}.${extension}`)));

    for (const concept of concepts) {
      let key = `${slug}-${concept.key}`;

      for (let suffix = 2; await taken(key); suffix += 1) key = `${slug}-${concept.key}-${suffix}`;
      keys.add(key);
      const title = freeTitle(concept.title, titles);

      live.concepts.set(key, { ...concept, title });
      slots.push({
        key,
        title,
        idea: concept.idea,
        file: join(folder, `${key}.${extension}`),
        state: "building",
        startedAt: null,
        endedAt: null,
        failure: null,
        fixed: false,
      });
    }

    const source = await readFile(join(deps.cwd, live.switchPath), "utf8");

    for (const slot of slots) {
      await writeFile(join(deps.cwd, slot.file), placeholderSource(pascal(slot.key)), {
        encoding: "utf8",
        flag: "wx",
      });
    }

    await writeFile(
      join(deps.cwd, live.switchPath),
      addSlots(
        source,
        slots.map((slot) => ({ key: slot.key, name: pascal(slot.key) })),
      ),
      "utf8",
    );

    // One at a time: registration rewrites one file, and parallel writers would lose entries.
    for (const slot of slots) {
      await serially(() =>
        deps.register({ title: slot.title, url: `/?v-${slug}=${slot.key}`, note: slot.idea }),
      );
    }

    job.slots = slots;

    // Stopped while the slots were going on the rail: they are there as placeholders, so the job lists them, stopped.
    if (job.state !== "planning") {
      for (const slot of slots) {
        slot.state = "stopped";
        slot.endedAt = now();
      }

      changed();

      return;
    }

    job.state = "building";
    job.plannedAt = now();
    changed();
    // Each slot's first attempt starts as it joins the job, with no wait between, so any later stop outranks it.
    await Promise.all(
      job.slots.map((slot) => {
        const attempt = begin(live, slot);

        return guarded(build(live, slot, attempt), (message) => lost(live, slot, attempt, message));
      }),
    );
  };

  const find = (id: string): Live | undefined => lives.find((live) => live.job.id === id);

  const stop = async (id: string, key?: string): Promise<boolean> => {
    const live = find(id);

    if (live === undefined) return false;
    const { job } = live;

    if (key === undefined && job.state === "planning") {
      job.state = "stopped";
      job.endedAt = now();
      changed();
      await live.plan?.stop();
      // Past its run, planning may still be writing the slots: stopped means those writes are done.
      await drain(live);

      return true;
    }

    const targets = job.slots.filter(
      (slot) =>
        (key === undefined || slot.key === key) &&
        (slot.state === "building" || slot.state === "checking"),
    );

    for (const slot of targets) {
      begin(live, slot);
      slot.state = "stopped";
      slot.endedAt = now();
    }

    settle(live);
    changed();
    // A half-written file never stays on the rail.
    await Promise.all(targets.map((slot) => release(live, slot)));

    return targets.length > 0;
  };

  return {
    async start(request) {
      if (closed) return { ok: false, error: "Leglas is closing." };

      if (request.agent.agent !== "claude") {
        return {
          ok: false,
          error:
            "Building directions runs on Claude for now. Choose Claude as the agent to use it.",
        };
      }

      const count = Math.floor(request.count);

      if (!Number.isFinite(count) || count < 1 || count > MAX_DIRECTIONS) {
        return { ok: false, error: `Ask for between 1 and ${MAX_DIRECTIONS} directions.` };
      }

      const brief = request.brief.trim();

      if (brief === "") return { ok: false, error: "Describe what the directions are for." };
      const slug = surfaceSlug(request.surface);

      if (slug === "") return { ok: false, error: "Name the surface to build directions for." };

      if (lives.some((live) => live.job.state === "planning" || live.job.state === "building")) {
        return {
          ok: false,
          error: "A set of directions is already being built. Wait for it, or stop it first.",
        };
      }

      const switchPath = await findSwitch(deps.cwd, slug);

      if (switchPath === null) {
        return {
          ok: false,
          error: `The ${slug} has no switch file yet. Run \`leglas new ${slug} --from <your component>\` and render ${pascal(slug)}Switch where the ${slug} is, then build directions into it.`,
        };
      }

      const job: GenerationJob = {
        id: `gen-${now().toString(36)}`,
        surface: slug,
        brief,
        count,
        state: "planning",
        startedAt: now(),
        plannedAt: null,
        endedAt: null,
        error: null,
        slots: [],
      };

      const live: Live = {
        job,
        concepts: new Map(),
        runs: new Map(),
        plan: null,
        switchPath,
        facts: null,
        stack: await stackOf(deps.cwd, switchPath),
        attempts: new Map(),
        pending: new Set(),
      };

      lives.push(live);

      while (lives.length > KEPT_JOBS) lives.shift();

      const existing = directionKeys(await readFile(join(deps.cwd, switchPath), "utf8"));

      changed();

      detach(live, plan(live, existing), (message) => {
        job.state = "failed";
        job.error = message;
        job.endedAt = now();
        changed();
      });

      return { ok: true, job: copy(job) };
    },

    snapshot: () => lives.map((live) => copy(live.job)),

    stop,

    retry(id, key) {
      const live = find(id);
      const slot = live?.job.slots.find((candidate) => candidate.key === key);

      // Once Leglas is closing, nothing new may start writing: close has stopped waiting.
      if (
        closed ||
        live === undefined ||
        slot === undefined ||
        (slot.state !== "failed" && slot.state !== "stopped") ||
        live.runs.has(slot.key)
      )
        return false;

      // Accepted means building from this moment, so the job never reads as stopped after a yes.
      const attempt = begin(live, slot);
      slot.state = "building";
      slot.startedAt = now();
      slot.failure = null;
      detach(
        live,
        restore(slot).then(() => build(live, slot, attempt)),
        (message) => lost(live, slot, attempt, message),
      );
      live.job.state = "building";
      live.job.endedAt = null;
      changed();

      return true;
    },

    replace(id, key) {
      const live = find(id);
      const slot = live?.job.slots.find((candidate) => candidate.key === key);

      if (
        closed ||
        live === undefined ||
        slot === undefined ||
        slot.state === "building" ||
        slot.state === "checking" ||
        live.runs.has(slot.key)
      )
        return false;

      const attempt = begin(live, slot);
      slot.state = "building";
      slot.startedAt = now();
      slot.failure = null;
      live.job.state = "building";
      live.job.endedAt = null;
      changed();

      const replacing = async (): Promise<void> => {
        const asking = run(
          planArgs(
            replacePrompt({
              surface: live.job.surface,
              brief: live.job.brief,
              avoid: [...live.concepts.values()],
            }),
          ),
          PLAN_DEADLINE_MS,
        );

        live.runs.set(slot.key, asking);
        const outcome = await asking.done;

        if (!owns(live, slot, attempt)) return;

        if (live.runs.get(slot.key) === asking) live.runs.delete(slot.key);
        let concept: Concept;

        try {
          if (outcome.code !== 0) throw new Error(failureOf(outcome).message);
          concept = parseConcepts(resultText(outcome.lines) ?? "", 1)[0]!;
        } catch (error) {
          fail(live, slot, {
            code: "unreadable-plan",
            message: error instanceof Error ? error.message : String(error),
          });
          settle(live);
          changed();

          return;
        }

        const titles = new Set(await deps.titles());

        if (!owns(live, slot, attempt)) return;
        titles.delete(slot.title);
        const title = freeTitle(concept.title, titles);
        await serially(async () => {
          await deps.unregister([slot.title]);

          return deps.register({
            title,
            url: `/?v-${surfaceSlug(live.job.surface)}=${slot.key}`,
            note: concept.idea,
          });
        });
        // The rail shows the new concept from here on, so the slot does too, whoever holds it now.
        live.concepts.set(slot.key, { ...concept, title });
        slot.title = title;
        slot.idea = concept.idea;

        if (!owns(live, slot, attempt)) return;
        await restore(slot);
        await build(live, slot, attempt);
      };

      detach(live, replacing(), (message) => lost(live, slot, attempt, message));

      return true;
    },

    async close() {
      closed = true;
      // Closing stops everything the way a stop does, then waits for work
      // still writing, so the process never exits halfway through a file.
      await Promise.race([
        Promise.all(
          lives.map(async (live) => {
            await stop(live.job.id);
            await drain(live);
          }),
        ),
        wait(KILL_GRACE_MS * 2 + 1000),
      ]);
    },
  };
}
