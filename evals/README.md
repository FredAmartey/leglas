# Coding agents against Leglas

A small [Harbor](https://github.com/laude-institute/harbor) benchmark made
from this repository's own history. Each task is a bug that was really fixed
here: the agent gets the repo as it was just before the fix, a bug report,
and a working toolchain. The tests the fix added or changed stay hidden and
decide the score afterwards, along with `pnpm build` and `pnpm -r typecheck`.
The verifier refuses a run that touched `vitest.config.ts` or the package
manifests, and checks by name that every hidden file was collected and
passed, since a green exit code is also what a run that collected nothing
returns.

Harbor is the harness behind Terminal-Bench 2.0. It builds each task's
container, installs the agent under test inside it, runs the instruction,
then runs the verifier in the same container and records the reward, the
agent's wall time, its token usage and cost.

## Tasks

| Task | Area | Difficulty | The bug, in one line |
| --- | --- | --- | --- |
| `shell-branch-preview-blank` | shell | easy | the interface blanks on a branch preview with no url yet |
| `agents-edit-without-path` | server | easy | a Cursor edit with no path is reported as a write, so the runner reruns on top of it |
| `share-stop-mid-start` | server | medium | a stop that lands while a share is still starting is forgotten |
| `share-backslash-paths` | server | medium | dev-server control routes spelled with backslashes reach viewers |
| `share-dotfile-viewers` | server | medium | viewers of a share can read dotfiles |
| `worktree-loopback-probe` | server | medium | an IPv6-only dev server is reported as never starting |
| `hydration-evidence` | server | medium | cache rehydration errors are mistaken for hydration mismatches |
| `changelog-parser-refusals` | root | medium | the changelog parser accepts three malformed constructs silently |

`evals/manifest.json` names the fix commit for each. `node evals/build.ts`
derives the rest from git: the parent commit becomes the environment, the
fix's test files become the hidden tests, the fix's source diff becomes the
oracle solution. The instruction and `task.toml` are written by hand and
kept when the build runs again.

Instructions describe what a user observes and what must be true afterwards,
plus any name or message a hidden test asserts on that could not be guessed.
They do not describe the fix.

## Running it

```sh
uv tool install harbor          # needs Docker
evals/run.sh oracle             # 8/8 expected: the real fixes pass
evals/run.sh nop                # 0/8 expected: doing nothing fails
evals/run.sh claude-code anthropic/claude-fable-5-1
evals/run.sh codex openai/gpt-6-astra
node evals/report.ts evals/jobs/claude-code-claude-fable-5-1 evals/jobs/codex-gpt-6-astra
```

Each task container is Node 24 with the repo cloned at the base commit,
history cut off there, dependencies installed and packages built. Harbor's
`--delete` default removes containers and images after each trial, but the
Docker build cache keeps about a gigabyte per task. On a machine without
that headroom, run half the tasks at a time with `TASK_NAMES=a,b,c,d` and a
`JOB_SUFFIX`, prune the builder between halves, and pass every job
directory to `report.ts`; it merges runs of the same agent and model.
Reasoning effort is whatever each model defaults to unless `--ak
reasoning_effort=...` is added to the run.

## Results

Run 2026-09-16 on an Apple Silicon Mac, Docker Desktop, two trials at a
time, one attempt per task, every model at its default reasoning effort.
Harbor 0.23.0, Claude Code 2.1.273 on `claude-fable-5-1`, Codex CLI
0.154.0 on `gpt-6-astra` (default effort low) and on `gpt-5.5` (default
effort medium). Calibration first: the oracle agent scored 8/8 and the nop
agent 0/8, so a pass means the hidden tests went from red to green and a
fail means they did not.

| Agent | Model | Trials | Pass rate | Exceptions | Median agent time | Mean tokens / trial (in + out) | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | claude-fable-5-1 | 8 | 100% (8/8) | 0 | 1.7 min | 215k (211k + 4.3k) | $4.75 |
| codex | gpt-5.5 | 8 | 100% (8/8) | 0 | 1.3 min | 203k (200k + 2.5k) | $2.20 |
| codex | gpt-6-astra | 8 | 100% (8/8) | 0 | 2.1 min | 266k (265k + 1.6k) | $4.21 |

| Task | claude-code (claude-fable-5-1) | codex (gpt-5.5) | codex (gpt-6-astra) |
| --- | --- | --- | --- |
| agents-edit-without-path | pass, 2.7 min, 137k tok | pass, 1.0 min, 161k tok | pass, 8.4 min, 531k tok |
| changelog-parser-refusals | pass, 1.6 min, 319k tok | pass, 1.9 min, 240k tok | pass, 1.4 min, 177k tok |
| hydration-evidence | pass, 1.6 min, 182k tok | pass, 2.1 min, 222k tok | pass, 1.0 min, 108k tok |
| share-backslash-paths | pass, 0.9 min, 147k tok | pass, 1.3 min, 165k tok | pass, 1.7 min, 187k tok |
| share-dotfile-viewers | pass, 3.4 min, 356k tok | pass, 1.3 min, 177k tok | pass, 3.6 min, 468k tok |
| share-stop-mid-start | pass, 4.4 min, 349k tok | pass, 2.5 min, 376k tok | pass, 6.3 min, 290k tok |
| shell-branch-preview-blank | pass, 0.5 min, 79k tok | pass, 0.9 min, 107k tok | pass, 1.0 min, 137k tok |
| worktree-loopback-probe | pass, 1.9 min, 154k tok | pass, 1.3 min, 174k tok | pass, 2.5 min, 232k tok |

What the numbers say:

- Every harness and model fixed every task on the first attempt, so at
  this size the set separates them on time and tokens, not on correctness.
  Eight tasks and one attempt each is a profile, not a leaderboard.
- The workload is prefill. Input averaged 211k tokens a trial for Claude
  Code, 200k for Codex on GPT-5.5 and 265k for Codex on GPT-6 astra; 92%,
  89% and 92% of that input was prompt cache reads, and output was 2.0%,
  1.2% and 0.6% of all tokens. Time to first token and cache hit rate
  decide the latency here, not decode throughput.
- Same harness, two models: GPT-6 astra at its default low effort read
  more and took longer than GPT-5.5 at medium (median 2.1 vs 1.3 min),
  with one 8-minute, 531k-token outlier on the easiest task. Reasoning
  effort is a harness knob worth profiling on its own.
- Agent setup, installing the harness into a fresh container, took 1.7 to
  3.1 minutes a trial for the first two runs and up to 16 minutes for the
  astra run, when the npm registry slowed down. Setup is excluded from the
  agent times above but it is real wall time a harness pays.
- The cost column is Harbor's estimate at API list prices. All runs went
  through subscriptions (`claude setup-token`, `~/.codex/auth.json`).
- Token counts are what Harbor parsed from each agent's trajectory. A later
  run on another repository showed that parse under-counting Codex when the
  agent starts a nested `codex review`; nothing here asks Codex to do that,
  but the raw usage events for these trials were not kept, so the Codex
  counts above stand unaudited.

The full report, with the JSON summary, is in
[`results/2026-09-16.md`](results/2026-09-16.md). Regenerate it from the
job directories with `node evals/report.ts`.
