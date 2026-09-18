# Coding agents against Leglas

A small [Harbor](https://github.com/laude-institute/harbor) benchmark made
from this repository's own history. Each task is a bug that was really fixed
here: the agent gets the repo as it was just before the fix, a bug report,
and a working toolchain. The tests the fix added or changed stay hidden and
decide the score afterwards, along with `pnpm build` and `pnpm -r typecheck`.
The verifier refuses a run in which `vitest.config.ts`, the manifests, the
root tsconfigs or any package's compiler and bundler configuration differ
from copies kept beside the hidden tests, or in which a package or a runner
config exists that the base commit did not have; it copies the hidden tests
back only after the build, so no package script can have touched them; and
it checks by exact path that every hidden file was collected and passed,
since a green exit code is also what a run that collected nothing returns.
It runs inside the agent's own container, as Harbor verifiers do, so an
agent that rewrote the test runner under `node_modules` is not defended
against: the benchmark measures agents fixing bugs, not agents attacking
the scorer.

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

Run 2026-09-18 on an Apple Silicon Mac, Docker Desktop, one attempt per
task, every model at its default reasoning effort. Harbor 0.23.0, Claude
Code 2.1.276 on `claude-fable-5-1`, Codex CLI 0.155.0 on `gpt-5.5` and on
`gpt-6-astra`. This is the verifier described above, calibrated the same
day: the oracle scored 8/8 and the nop agent 0/8, so a pass means the
hidden tests went from red to green and a fail means they did not.

| Agent | Model | Trials | Pass rate | Exceptions | Median agent time | Mean tokens / trial (in + out) | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| oracle | | 8 | 100% (8/8) | 0 | 0.0 min | 0 (0 + 0) | n/a |
| nop | | 8 | 0% (0/8) | 0 | 0.0 min | 0 (0 + 0) | n/a |
| codex | gpt-5.5 | 8 | 88% (7/8) | 0 | 1.2 min | 209k (206k + 2.5k) | $2.39 |
| codex | gpt-6-astra | 12 | 67% (8/12) | 4 | 1.0 min | 105k (104k + 699) | $3.46 |
| claude-code | claude-fable-5-1 | 8 | 100% (8/8) | 0 | 1.7 min | 236k (231k + 4.6k) | $4.93 |

| Task | oracle | nop | codex (gpt-5.5) | codex (gpt-6-astra) | claude-code (claude-fable-5-1) |
| --- | --- | --- | --- | --- | --- |
| agents-edit-without-path | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 0.8 min, 174k tok | fail, n/a, 0 tok; pass, 1.3 min, 168k tok | pass, 2.1 min, 184k tok |
| changelog-parser-refusals | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 2.4 min, 376k tok | pass, 1.1 min, 146k tok | pass, 1.6 min, 241k tok |
| hydration-evidence | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | fail, 1.5 min, 224k tok | fail, 0.0 min, 0 tok; pass, 0.8 min, 89k tok | pass, 0.8 min, 128k tok |
| share-backslash-paths | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 1.0 min, 165k tok | fail, 0.0 min, 0 tok; pass, 0.9 min, 182k tok | pass, 1.0 min, 167k tok |
| share-dotfile-viewers | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 2.0 min, 289k tok | pass, 1.5 min, 233k tok | pass, 1.9 min, 259k tok |
| share-stop-mid-start | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 1.3 min, 242k tok | fail, n/a, 0 tok; pass, 1.5 min, 211k tok | pass, 1.9 min, 265k tok |
| shell-branch-preview-blank | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 0.7 min, 100k tok | pass, 0.7 min, 117k tok | pass, 3.7 min, 478k tok |
| worktree-loopback-probe | pass, 0.0 min, 0 tok | fail, 0.0 min, 0 tok | pass, 0.8 min, 99k tok | pass, 1.0 min, 114k tok | pass, 0.9 min, 161k tok |

What the numbers say:

- Claude Code fixed every task. GPT-6 astra fixed every task it ran. GPT-5.5
  missed one: on hydration-evidence 22 of its 23 hidden tests passed, and
  the last expects the literal wording `the app` for a framework the
  detector does not recognise, which the instruction leaves to the agent.
- Four GPT-6 astra trials raised before the agent ran: the host disk filled
  during the run and Docker returned I/O errors. They count as failures in
  the table, which is how `report.ts` is written, and the four tasks were
  rerun one at a time and passed. Over the eight completed astra trials the
  mean is 158k tokens a trial, against the 105k the table averages over
  twelve.
- The hardened verifier changed no reward. No trial in the run was refused
  for touching a guarded file; every refusal was hidden tests that did not
  pass. Against the run of 2026-09-16 under the old verifier, the only
  difference is GPT-5.5's one miss, which is the agent, not the checks.
- The first legs ran two trials at a time and the rest one at a time, so
  wall time is not comparable across the run. The times here are each
  agent's own, as before, and setup is excluded.
- Token counts are what Harbor parsed from each agent's trajectory. The
  Codex counts stand unaudited, as noted for the earlier run.

The full report, with the JSON summary, is in
[`results/2026-09-18.md`](results/2026-09-18.md). The run of 2026-09-16,
under the verifier before it was hardened, is kept in
[`results/2026-09-16.md`](results/2026-09-16.md). Regenerate a report from
job directories with `node evals/report.ts`.
