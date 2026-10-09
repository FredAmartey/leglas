import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compare,
  formatCeilings,
  lower,
  parseCeilings,
  splitCount,
  unexplainedRaises,
  type CeilingFile,
  type Verdict,
} from "./ceilings.ts";

import {
  ADD_DEADLINE_MS,
  BenchUnavailable,
  JOURNEYS,
  findHost,
  runJourneys,
  type Check,
  type Counts,
  type JourneyName,
  type RunResult,
} from "./journeys.ts";

/**
 * `node bench/run.ts` walks the journeys people spend their time in, counts
 * each one exactly and holds every count to its ceiling in ceilings.json.
 * Counts gate; clocks and memory are printed beside them as evidence and never
 * gate. It needs `pnpm build` first, which `pnpm bench` runs.
 *
 * Exits 0 within every ceiling; 1 on a regression, a stale ceiling, a failed
 * check or a count that differs between runs; 2 on a usage error or a machine
 * it can't run on.
 */

const USAGE = `node bench/run.ts [options]

  --journey <name>          Only this journey: ${JOURNEYS.join(" or ")}. Idle boots first.
  --runs <n>                Walk n times; every count must come out the same each time.
  --update                  Lower every stale ceiling to what was measured. Never raises.
  --raise <journey.count>   Raise one ceiling to what was measured. Needs --why.
  --why <text>              Why, logged in the raised list of bench/ceilings.json.
  --check-ceilings <ref>    Only check that no ceiling rose since <ref> without a raised entry.
  --json                    Print the summary as JSON instead of the table.
`;

const here = fileURLToPath(new URL(".", import.meta.url));

const CEILINGS = join(here, "ceilings.json");

const RESULTS = join(here, "results.json");

class UsageError extends Error {}

type Options = {
  journeys: JourneyName[];
  runs: number;
  update: boolean;
  raise: { journey: JourneyName; count: string; why: string } | null;
  checkCeilings: string | null;
  json: boolean;
};

function isJourney(value: string): value is JourneyName {
  return JOURNEYS.some((journey) => journey === value);
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    journeys: [...JOURNEYS],
    runs: 1,
    update: false,
    raise: null,
    checkCeilings: null,
    json: false,
  };

  let raise: string | null = null;
  let why: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";

    const value = (): string => {
      const next = argv[index + 1];

      if (next === undefined || next.startsWith("--"))
        throw new UsageError(`${flag} needs a value.`);
      index += 1;

      return next;
    };

    if (flag === "--journey") {
      const name = value();

      if (!isJourney(name)) throw new UsageError(`There is no journey called ${name}.`);
      options.journeys = [name];
    } else if (flag === "--runs") {
      const runs = Number(value());

      if (!Number.isInteger(runs) || runs < 1)
        throw new UsageError("--runs takes a whole number above 0.");
      options.runs = runs;
    } else if (flag === "--update") {
      options.update = true;
    } else if (flag === "--raise") {
      raise = value();
    } else if (flag === "--why") {
      why = value().trim();
    } else if (flag === "--check-ceilings") {
      options.checkCeilings = value();
    } else if (flag === "--json") {
      options.json = true;
    } else {
      throw new UsageError(`Unknown option ${flag}.`);
    }
  }

  if ((raise === null) !== (why === null)) throw new UsageError("--raise and --why go together.");

  if (raise !== null && why !== null) {
    const split = splitCount(raise);

    if (split === null || !isJourney(split.journey)) {
      throw new UsageError("--raise takes <journey>.<count>, such as boot.requests.api.");
    }

    if (why === "") throw new UsageError("--why needs a reason someone else can read.");

    if (!options.journeys.includes(split.journey)) {
      throw new UsageError(`--raise ${raise} needs the ${split.journey} journey to run.`);
    }

    options.raise = { journey: split.journey, count: split.count, why };
  }

  return options;
}

/** The ceilings file as it was at a git ref, or null when it didn't exist there. */
function ceilingsAt(ref: string): CeilingFile | null {
  let text: string;

  try {
    text = execFileSync("git", ["show", `${ref}:bench/ceilings.json`], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const said = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";

    if (/does not exist|exists on disk, but not in/.test(said)) return null;

    throw new UsageError(`git could not read bench/ceilings.json at ${ref}. ${said}`);
  }

  return parseCeilings(text);
}

function checkCeilings(ref: string): number {
  const base = ceilingsAt(ref);

  if (base === null) {
    process.stdout.write(`${ref} has no bench/ceilings.json, so no ceiling can have risen.\n`);

    return 0;
  }

  const unexplained = unexplainedRaises(base, parseCeilings(readFileSync(CEILINGS, "utf8")));

  if (unexplained.length === 0) {
    process.stdout.write(`No ceiling rose since ${ref} without an entry in raised.\n`);

    return 0;
  }

  process.stdout.write(`These ceilings rose since ${ref} with no entry in raised:\n`);

  for (const line of unexplained) process.stdout.write(`  ${line}\n`);
  process.stdout.write("Raise a ceiling with: pnpm bench --raise <journey.count> --why <reason>\n");

  return 1;
}

type Range = { median: number; min: number; max: number };

type Summary = {
  name: JourneyName;
  /** Counts that came out the same on every run. */
  counts: Counts;
  /** Counts that didn't, with each run's value. */
  varied: Record<string, number[]>;
  verdicts: Verdict[];
  /** One per check: passed on every run, or the first failure. */
  checks: Check[];
  clocks: Record<string, Range>;
  memoryMb: Range;
};

function spread(values: readonly number[]): Range {
  const sorted = values.toSorted((left, right) => left - right);

  return {
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function summarise(name: JourneyName, runs: readonly RunResult[], ceilings: Counts): Summary {
  const results = runs.flatMap((run) => run.journeys.filter((journey) => journey.name === name));
  const counts: Counts = {};
  const varied: Record<string, number[]> = {};

  for (const count of new Set(results.flatMap((result) => Object.keys(result.counts)))) {
    const values = results.map((result) => result.counts[count] ?? 0);

    if (values.every((value) => value === values[0])) counts[count] = values[0] ?? 0;
    else varied[count] = values;
  }

  const checks: Check[] = [];

  for (const check of new Set(
    results.flatMap((result) => result.checks.map((entry) => entry.name)),
  )) {
    const outcomes = results.flatMap((result) =>
      result.checks.filter((entry) => entry.name === check),
    );

    const failed = outcomes.filter((entry) => !entry.ok);
    const first = failed[0];

    checks.push(
      first === undefined
        ? { name: check, ok: true, detail: "" }
        : {
            name: check,
            ok: false,
            detail: `${first.detail} (${failed.length} of ${outcomes.length} runs)`,
          },
    );
  }

  const clocks: Record<string, Range> = {};

  for (const clock of new Set(results.flatMap((result) => Object.keys(result.clocks)))) {
    clocks[clock] = spread(results.map((result) => result.clocks[clock] ?? 0));
  }

  return {
    name,
    counts,
    varied,
    // A count that differs between runs has no one value to hold to a
    // ceiling, so it is reported as varying and fails on that alone.
    verdicts: compare(ceilings, counts).filter((verdict) => !(verdict.count in varied)),
    checks,
    clocks,
    memoryMb: spread(results.map((result) => result.memoryMb)),
  };
}

function shownMs(ms: number): string {
  if (ms < 0) return "never";

  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function shownRange(range: Range, runs: number): string {
  const median = shownMs(range.median);

  return runs === 1 ? median : `${median} (${shownMs(range.min)} to ${shownMs(range.max)})`;
}

const CLOCKS = new Map([
  ["ready", "rail and stage ready"],
  ["settled", "boot work done"],
  ["add", "added direction on the rail"],
]);

function table(summaries: readonly Summary[], runs: number): string {
  const lines = [
    `Leglas journeys, ${runs} run${runs === 1 ? "" : "s"} on Node ${process.versions.node}`,
    "",
  ];

  for (const summary of summaries) {
    const names = [
      ...summary.verdicts.map((verdict) => verdict.count),
      ...Object.keys(summary.varied),
    ];

    const width = Math.max(24, ...names.map((name) => name.length));
    lines.push(
      `${summary.name.padEnd(width + 2)}${"ceiling".padStart(8)}${"measured".padStart(10)}`,
    );

    for (const verdict of summary.verdicts) {
      const note =
        verdict.status === "regression"
          ? `  over by ${verdict.measured - verdict.ceiling}`
          : verdict.status === "stale"
            ? `  under by ${verdict.ceiling - verdict.measured}, lower it with pnpm bench:update`
            : "";

      lines.push(
        `  ${verdict.count.padEnd(width)}${String(verdict.ceiling).padStart(8)}${String(verdict.measured).padStart(10)}${note}`,
      );
    }

    for (const [count, values] of Object.entries(summary.varied)) {
      lines.push(
        `  ${count.padEnd(width)}${"".padStart(8)}${"varies".padStart(10)}  ${values.join(" ")}`,
      );
    }

    // Absent counts are zero, so say so where a whole family is absent.
    if (!names.some((name) => name.startsWith("processes."))) lines.push("  no processes started");

    if (!names.some((name) => name.startsWith("alive.")))
      lines.push("  no processes alive at the end");

    for (const check of summary.checks) {
      lines.push(
        `  ${check.ok ? "pass" : "FAIL"}  ${check.name}${check.ok ? "" : `: ${check.detail}`}`,
      );
    }

    const clocks = [...CLOCKS].flatMap(([clock, label]) => {
      const range = summary.clocks[clock];

      return range === undefined ? [] : [`${label} ${shownRange(range, runs)}`];
    });

    lines.push(`  clocks: ${[...clocks, `memory ${summary.memoryMb.median}MB`].join(", ")}`, "");
  }

  return lines.join("\n");
}

async function measure(options: Options): Promise<number> {
  const host = findHost();
  const file = parseCeilings(readFileSync(CEILINGS, "utf8"));
  const runs: RunResult[] = [];
  // About five seconds a walk, and a minute and a quarter with idle.
  const minutes = Math.ceil((options.runs * (options.journeys.includes("idle") ? 75 : 5)) / 60);

  if (!options.json) {
    process.stderr.write(
      `Walking ${options.journeys.join(" and ")} ${options.runs}x, about ${minutes} min.\n`,
    );
  }

  for (let index = 0; index < options.runs; index += 1) {
    runs.push(await runJourneys(host, options.journeys));

    if (!options.json) process.stderr.write(`  walk ${index + 1} of ${options.runs} done\n`);
  }

  const counted = options.journeys.map((name) => summarise(name, runs, file.ceilings[name] ?? {}));
  let ceilings = file.ceilings;
  let raised = file.raised;

  if (options.update) {
    ceilings = Object.fromEntries(
      Object.entries(ceilings).map(([name, counts]) => {
        const summary = counted.find((entry) => entry.name === name);

        return [
          name,
          summary === undefined
            ? counts
            : lower(counts, summary.counts, Object.keys(summary.varied)),
        ];
      }),
    );

    // A journey with no ceilings yet takes its first measurement as them.
    for (const summary of counted) ceilings[summary.name] ??= { ...summary.counts };
  }

  if (options.raise !== null) {
    const { journey, count, why } = options.raise;
    const summary = counted.find((entry) => entry.name === journey);

    if (summary === undefined || count in summary.varied) {
      throw new UsageError(
        `${journey}.${count} differed between runs; there is no one value to raise it to.`,
      );
    }

    const from = ceilings[journey]?.[count] ?? 0;
    const to = summary.counts[count] ?? 0;

    if (to <= from)
      throw new UsageError(`${journey}.${count} measured ${to}, within its ceiling of ${from}.`);
    ceilings = { ...ceilings, [journey]: { ...ceilings[journey], [count]: to } };
    raised = [
      ...raised,
      { count: `${journey}.${count}`, from, to, why, on: new Date().toISOString().slice(0, 10) },
    ];
  }

  if (ceilings !== file.ceilings || raised !== file.raised) {
    writeFileSync(CEILINGS, formatCeilings({ ceilings, raised }));
  }

  const summaries = options.journeys.map((name) => summarise(name, runs, ceilings[name] ?? {}));

  const results = {
    node: process.versions.node,
    runs: options.runs,
    addDeadlineMs: ADD_DEADLINE_MS,
    journeys: summaries,
    walks: runs,
  };

  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(
    options.json ? `${JSON.stringify(summaries, null, 2)}\n` : table(summaries, options.runs),
  );

  const failing = summaries.some(
    (summary) =>
      Object.keys(summary.varied).length > 0 ||
      summary.verdicts.some((verdict) => verdict.status !== "ok") ||
      summary.checks.some((check) => !check.ok),
  );

  return failing ? 1 : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    if (argv.includes("--help")) {
      process.stdout.write(USAGE);

      return 0;
    }

    const options = parseOptions(argv);

    if (options.checkCeilings !== null) return checkCeilings(options.checkCeilings);

    return await measure(options);
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof BenchUnavailable)) throw error;
    process.stderr.write(`${error.message}\n`);

    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}`);

    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
