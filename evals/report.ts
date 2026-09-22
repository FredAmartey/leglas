/**
 * Summarise one or more Harbor job directories as a markdown table and a
 * JSON block: pass rate, agent wall time, tokens and cost per trial.
 *
 *   node evals/report.ts <jobs-dir>/<job-name> [<jobs-dir>/<job-name> ...]
 *
 * A trial that raised (agent crash, timeout, build failure) counts as a
 * failure, and the table says how many did, so a pass rate never hides an
 * exception behind a zero.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

type Trial = {
  task: string;
  reward: number;
  agentSeconds: number | null;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  costUsd: number | null;
  exception: string | null;
};

type Summary = {
  job: string;
  agent: string;
  model: string;
  trials: number;
  passed: number;
  passRate: number;
  exceptions: number;
  medianAgentMinutes: number | null;
  meanAgentMinutes: number | null;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanTotalTokens: number;
  totalCostUsd: number | null;
  perTask: Record<string, TaskRun[]>;
  agentMinutes: number[];
};

type TaskRun = { reward: number; minutes: number | null; tokens: number };

const seconds = (span: { started_at?: string; finished_at?: string } | null | undefined) =>
  span?.started_at && span?.finished_at
    ? (Date.parse(span.finished_at) - Date.parse(span.started_at)) / 1000
    : null;

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);

  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function readJob(dir: string): Summary {
  const trials: Trial[] = [];
  let agent = "?";
  let model = "?";

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "result.json");

    if (!existsSync(file)) continue;
    const r = JSON.parse(readFileSync(file, "utf8"));
    agent = r.agent_info?.name ?? agent;
    model = r.agent_info?.model_info?.name ?? model;
    const a = r.agent_result ?? {};
    trials.push({
      task: r.task_name,
      reward: Number(r.verifier_result?.rewards?.reward ?? 0),
      agentSeconds: seconds(r.agent_execution),
      inputTokens: a.n_input_tokens ?? 0,
      cacheTokens: a.n_cache_tokens ?? 0,
      outputTokens: a.n_output_tokens ?? 0,
      costUsd: a.cost_usd ?? null,
      exception: r.exception_info?.exception_type ?? null,
    });
  }

  trials.sort((a, b) => a.task.localeCompare(b.task));
  const passed = trials.filter((t) => t.reward >= 1).length;
  const minutes = trials.flatMap((t) => (t.agentSeconds === null ? [] : [t.agentSeconds / 60]));
  const costs = trials.flatMap((t) => (t.costUsd === null ? [] : [t.costUsd]));
  const perTask: Record<string, TaskRun[]> = {};

  for (const t of trials)
    (perTask[t.task] ??= []).push({
      reward: t.reward,
      minutes: t.agentSeconds === null ? null : t.agentSeconds / 60,
      tokens: t.inputTokens + t.outputTokens,
    });

  return {
    job: basename(dir),
    agent,
    model,
    trials: trials.length,
    passed,
    passRate: trials.length ? passed / trials.length : 0,
    exceptions: trials.filter((t) => t.exception).length,
    medianAgentMinutes: median(minutes),
    meanAgentMinutes: minutes.length ? mean(minutes) : null,
    meanInputTokens: Math.round(mean(trials.map((t) => t.inputTokens))),
    meanOutputTokens: Math.round(mean(trials.map((t) => t.outputTokens))),
    meanTotalTokens: Math.round(mean(trials.map((t) => t.inputTokens + t.outputTokens))),
    totalCostUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(2)) : null,
    perTask,
    agentMinutes: minutes,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const min = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)} min`);

const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)}k` : String(x));

// Jobs for the same agent and model merge into one row, so a run split
// across batches (see run.sh) reports as one.
const merged = new Map<string, Summary[]>();

for (const j of process.argv.slice(2).map(readJob)) {
  const key = `${j.agent} ${j.model}`;
  merged.set(key, [...(merged.get(key) ?? []), j]);
}

const jobs = [...merged.values()].map((parts) => {
  if (parts.length === 1) return parts[0];
  const trials = parts.reduce((n, p) => n + p.trials, 0);
  const passed = parts.reduce((n, p) => n + p.passed, 0);

  const wsum = (f: (p: Summary) => number) =>
    parts.reduce((n, p) => n + f(p) * p.trials, 0) / trials;

  const perTask: Record<string, TaskRun[]> = {};

  for (const p of parts)
    for (const [t, rs] of Object.entries(p.perTask)) (perTask[t] ??= []).push(...rs);
  const minutes = parts.flatMap((p) => p.agentMinutes);
  const costs = parts.flatMap((p) => (p.totalCostUsd === null ? [] : [p.totalCostUsd]));

  return {
    ...parts[0],
    job: parts.map((p) => p.job).join("+"),
    trials,
    passed,
    passRate: passed / trials,
    exceptions: parts.reduce((n, p) => n + p.exceptions, 0),
    medianAgentMinutes: median(minutes),
    meanAgentMinutes: minutes.length ? mean(minutes) : null,
    meanInputTokens: Math.round(wsum((p) => p.meanInputTokens)),
    meanOutputTokens: Math.round(wsum((p) => p.meanOutputTokens)),
    meanTotalTokens: Math.round(wsum((p) => p.meanTotalTokens)),
    totalCostUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(2)) : null,
    perTask,
    agentMinutes: minutes,
  };
});

if (jobs.length === 0) {
  console.error("usage: node evals/report.ts <job-dir> [...]");
  process.exit(2);
}

const tasks = [...new Set(jobs.flatMap((j) => Object.keys(j.perTask)))].sort();

console.log(
  "| Agent | Model | Trials | Pass rate | Exceptions | Median agent time | Mean tokens / trial (in + out) | Cost |",
);

console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");

for (const j of jobs) {
  console.log(
    `| ${j.agent} | ${j.model} | ${j.trials} | ${pct(j.passRate)} (${j.passed}/${j.trials}) | ${j.exceptions} | ${min(j.medianAgentMinutes)} | ${k(j.meanTotalTokens)} (${k(j.meanInputTokens)} + ${k(j.meanOutputTokens)}) | ${j.totalCostUsd === null ? "n/a" : `$${j.totalCostUsd.toFixed(2)}`} |`,
  );
}

console.log();

const run = (r: TaskRun) =>
  `${r.reward >= 1 ? "pass" : "fail"}, ${r.minutes === null ? "n/a" : `${r.minutes.toFixed(1)} min`}, ${k(r.tokens)} tok`;

console.log(`| Task | ${jobs.map((j) => `${j.agent} (${j.model})`).join(" | ")} |`);

console.log(`| --- |${jobs.map(() => " --- ").join("|")}|`);

for (const t of tasks) {
  console.log(
    `| ${t} | ${jobs.map((j) => (j.perTask[t] ?? []).map(run).join("; ") || "n/a").join(" | ")} |`,
  );
}

console.log();

console.log("```json");

console.log(
  JSON.stringify(
    jobs.map(({ perTask: _perTask, agentMinutes: _minutes, ...rest }) => rest),
    null,
    2,
  ),
);

console.log("```");
