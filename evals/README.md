# Coding agents against Leglas

A small [Harbor](https://github.com/laude-institute/harbor) benchmark made
from this repository's own history. Each task is a bug that was really fixed
here: the agent gets the repo as it was just before the fix, a bug report,
and a working toolchain. The tests the fix added or changed stay hidden and
decide the score afterwards, along with `pnpm build` and `pnpm -r typecheck`.

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
evals/run.sh claude-code anthropic/claude-opus-5
evals/run.sh codex openai/gpt-5.5
node evals/report.ts evals/jobs/claude-code-claude-opus-5 evals/jobs/codex-gpt-5.5
```

Each task container is Node 24 with the repo cloned at the base commit,
history cut off there, dependencies installed and packages built. Harbor's
`--delete` default removes containers and images after each trial; the
Docker build cache keeps reruns fast.

## Results

Run 2026-09-16 on an Apple Silicon Mac, Docker Desktop, two trials at a
time, one attempt per task. Harbor 0.23.0, Claude Code 2.1.273 on
`claude-fable-5-1`, Codex CLI 0.154.0 on `gpt-5.5`. Calibration first:
the oracle agent scored 8/8 and the nop agent 0/8, so a pass means the
hidden tests went from red to green and a fail means they did not.

| Agent | Model | Trials | Pass rate | Exceptions | Median agent time | Mean tokens / trial (in + out) | Cost |
|---|---|---|---|---|---|---|---|
| claude-code | claude-fable-5-1 | 8 | 100% (8/8) | 0 | 1.7 min | 215k (211k + 4.3k) | $4.75 |
| codex | gpt-5.5 | 8 | 100% (8/8) | 0 | 1.3 min | 203k (200k + 2.5k) | $2.20 |

| Task | claude-code (claude-fable-5-1) | codex (gpt-5.5) |
|---|---|---|
| agents-edit-without-path | pass, 2.7 min, 137k tok | pass, 1.0 min, 161k tok |
| changelog-parser-refusals | pass, 1.6 min, 319k tok | pass, 1.9 min, 240k tok |
| hydration-evidence | pass, 1.6 min, 182k tok | pass, 2.1 min, 222k tok |
| share-backslash-paths | pass, 0.9 min, 147k tok | pass, 1.3 min, 165k tok |
| share-dotfile-viewers | pass, 3.4 min, 356k tok | pass, 1.3 min, 177k tok |
| share-stop-mid-start | pass, 4.4 min, 349k tok | pass, 2.5 min, 376k tok |
| shell-branch-preview-blank | pass, 0.5 min, 79k tok | pass, 0.9 min, 107k tok |
| worktree-loopback-probe | pass, 1.9 min, 154k tok | pass, 1.3 min, 174k tok |

What the numbers say:

- Both harnesses fixed every task on the first attempt, so at this size
  the set separates them on time and tokens, not on correctness. Eight
  tasks and one attempt each is a profile, not a leaderboard.
- The workload is prefill. Input averaged about 210k tokens a trial for
  both agents; 92% of Claude Code's input and 89% of Codex's were prompt
  cache reads, and output was 2.0% and 1.2% of all tokens. Time to first
  token and cache hit rate decide the latency here, not decode throughput.
- Agent setup, installing the harness into a fresh container, took 1.7 to
  3.1 minutes a trial, longer than most of the fixes it preceded.
- The cost column is Harbor's estimate at API list prices. Both runs went
  through subscriptions (`claude setup-token`, `~/.codex/auth.json`).

The full report, with the JSON summary, is in
[`results/2026-09-16.md`](results/2026-09-16.md). Regenerate it from the
job directories with `node evals/report.ts`.
