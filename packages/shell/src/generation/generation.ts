/**
 * A set of directions Leglas builds itself, as the server reports it. The
 * server is the same release as this shell, so these mirror its types in
 * `generation.ts` rather than importing them.
 */
export type SlotState = "building" | "checking" | "ready" | "failed" | "stopped";

export type GenerationSlot = {
  key: string;
  title: string;
  idea: string;
  file: string;
  state: SlotState;
  startedAt: number | null;
  endedAt: number | null;
  failure: { code: string; message: string } | null;
  /** Its first version did not render and a fix run repaired it. */
  fixed: boolean;
  /** What its build is doing right now, such as "editing src/heroes/hero-ledger.tsx". */
  activity: string | null;
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

export type SlotView = { job: GenerationJob; slot: GenerationSlot };

/** The most directions one set may ask for, as the server enforces it. */
export const MAX_DIRECTIONS = 6;

/**
 * The surface a direction belongs to: the `v-<surface>` parameter in its
 * address, which is what the switch reads. Null for a direction that is not
 * on a switch, such as a branch.
 */
export function surfaceOf(url: string): string | null {
  let search: URLSearchParams;

  try {
    search = new URL(url, "http://leglas.invalid").searchParams;
  } catch {
    return null;
  }

  for (const name of search.keys()) {
    if (name.startsWith("v-") && name.length > 2) return name.slice(2);
  }

  return null;
}

/**
 * Each generated direction's slot, by title. A newer set's slot wins, the
 * way a second set or a replaced idea supersedes the one before it.
 */
export function slotsByTitle(jobs: readonly GenerationJob[]): Map<string, SlotView> {
  const views = new Map<string, SlotView>();

  for (const job of jobs) {
    for (const slot of job.slots) views.set(slot.title, { job, slot });
  }

  return views;
}

/**
 * Whether a direction's address is this slot's, `v-<surface>=<key>`. A title
 * alone is not enough: once a failed direction is deleted, a hand-made one
 * may take its title, and the old slot must not speak for it.
 */
export function isSlotOf(url: string, view: SlotView): boolean {
  try {
    return (
      new URL(url, "http://leglas.invalid").searchParams.get(`v-${view.job.surface}`) ===
      view.slot.key
    );
  } catch {
    return false;
  }
}

/**
 * How long after planning a slot may start and still belong to the set's
 * first run. Builds start together, within milliseconds of the plan; a later
 * start is a retry or a new idea.
 */
const RESTART_GAP_MS = 2000;

/** When the set's current run began: its latest retry or new idea, or else the set itself. */
export function runStartedAt(job: GenerationJob): number {
  let latest = job.startedAt;

  for (const slot of job.slots) {
    if (slot.startedAt === null) continue;

    // A set stopped before its plan landed has no plan time; any start there is a retry.
    if (job.plannedAt === null || slot.startedAt - job.plannedAt > RESTART_GAP_MS) {
      latest = Math.max(latest, slot.startedAt);
    }
  }

  return latest;
}

/** The set whose result the card should show once nothing runs: the one that ended last. */
export function lastEnded(jobs: readonly GenerationJob[]): GenerationJob | null {
  let last: GenerationJob | null = null;

  for (const job of jobs) {
    if (job.endedAt !== null && (last === null || job.endedAt > (last.endedAt ?? 0))) last = job;
  }

  return last;
}

/** One ending of a set, so dismissing it does not hide a later ending of the same set. */
export function endingOf(job: GenerationJob): string {
  return `${job.id}@${job.endedAt ?? ""}`;
}

/** Every surface the project's directions sit on, in the order they first appear. */
export function surfacesOf(urls: readonly string[]): string[] {
  const found = new Set<string>();

  for (const url of urls) {
    const surface = surfaceOf(url);

    if (surface !== null) found.add(surface);
  }

  return [...found];
}

export function isRunning(job: GenerationJob): boolean {
  return job.state === "planning" || job.state === "building";
}

function directions(count: number, surface: string): string {
  return `${count} ${surface} ${count === 1 ? "direction" : "directions"}`;
}

function names(slots: readonly GenerationSlot[]): string {
  const titles = slots.map((slot) => slot.title);

  if (titles.length <= 1) return titles.join("");

  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

export type GenerationCard = {
  tone: "working" | "done" | "failed" | "stopped";
  text: string;
};

/** What the card above the composer says about a set. */
export function cardFor(job: GenerationJob): GenerationCard {
  const ready = job.slots.filter((slot) => slot.state === "ready");
  const failed = job.slots.filter((slot) => slot.state === "failed");
  const stopped = job.slots.filter((slot) => slot.state === "stopped");

  if (job.state === "planning") {
    return { tone: "working", text: `Planning ${directions(job.count, job.surface)}…` };
  }

  if (job.state === "building") {
    const progress = ready.length > 0 ? `, ${ready.length} ready` : "";

    return {
      tone: "working",
      text: `Building ${directions(job.slots.length, job.surface)}${progress}`,
    };
  }

  if (job.state === "failed") {
    return { tone: "failed", text: job.error ?? "Leglas could not plan the directions." };
  }

  if (job.slots.length === 0 || stopped.length === job.slots.length) {
    return { tone: "stopped", text: `Stopped the ${job.surface} directions` };
  }

  if (ready.length === job.slots.length) {
    // After a retry the set's own start says nothing about how long it took.
    const seconds =
      job.endedAt === null || runStartedAt(job) !== job.startedAt
        ? null
        : Math.max(1, Math.round((job.endedAt - job.startedAt) / 1000));

    return {
      tone: "done",
      text: `${directions(ready.length, job.surface)} ready${seconds === null ? "" : ` in ${seconds} s`}`,
    };
  }

  const parts =
    ready.length > 0
      ? [`${ready.length} of ${job.slots.length} ready`]
      : job.slots.length > 1
        ? [`None of the ${job.slots.length} were built`]
        : [];

  if (failed.length > 0) parts.push(`${names(failed)} failed`);

  if (stopped.length > 0) parts.push(`${names(stopped)} stopped`);

  return { tone: failed.length > 0 ? "failed" : "stopped", text: parts.join(". ") };
}

/** The build button's words: what it will make, and whose plan pays for it. */
export function buildLabel(count: number): string {
  return `Build ${count} with Claude`;
}
