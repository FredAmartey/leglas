#!/usr/bin/env bash
# Run the leglas Harbor benchmark with one agent.
#
#   evals/run.sh claude-code anthropic/claude-opus-5
#   evals/run.sh codex openai/gpt-5.5
#   evals/run.sh oracle          # every task should score 1
#   evals/run.sh nop             # every task should score 0
#
# Jobs land in evals/jobs/<agent>-<model>. Both real agents run on a
# subscription rather than an API key: Claude Code through the token from
# `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN, Codex through
# ~/.codex/auth.json. Set N_ATTEMPTS for pass@k style repeats and
# N_CONCURRENT to match the memory Docker has (each task asks for 3G).
set -euo pipefail

agent="${1:?agent name: claude-code, codex, oracle or nop}"
model="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
jobs="${JOBS_DIR:-$here/jobs}"
name="${agent}${model:+-${model##*/}}"

case "$agent" in
  claude-code)
    : "${CLAUDE_CODE_OAUTH_TOKEN:?run \`claude setup-token\` and export CLAUDE_CODE_OAUTH_TOKEN}"
    export CLAUDE_FORCE_OAUTH=1
    ;;
  codex)
    export CODEX_FORCE_AUTH_JSON=1
    ;;
esac

args=(run -p "$here/tasks" -a "$agent" -o "$jobs" --job-name "$name${JOB_SUFFIX:-}" \
  --n-concurrent "${N_CONCURRENT:-2}" --n-attempts "${N_ATTEMPTS:-1}")
[ -n "$model" ] && args+=(-m "$model")
# TASK_NAMES=a,b,c limits the run to those tasks. Docker's build cache holds
# about a gigabyte per task, so on a small disk run half the tasks, prune
# the builder, then the other half; report.ts merges the jobs.
if [ -n "${TASK_NAMES:-}" ]; then
  IFS=, read -ra names <<< "$TASK_NAMES"
  for t in "${names[@]}"; do args+=(--include-task-name "$t"); done
fi

# HARBOR_ARGS passes anything else through, for example
# "--agent-setup-timeout-multiplier 3" when the npm registry is slow and the
# agent install inside the container runs past Harbor's six minutes.
# shellcheck disable=SC2206
args+=(${HARBOR_ARGS:-})

exec harbor "${args[@]}"
