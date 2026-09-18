#!/usr/bin/env bash
# Verifier: put the hidden tests back, build, run them, typecheck.
# Reward is 1 only when every step passes and every hidden test file ran.
set -u
mkdir -p /logs/verifier
cd /app

while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "/app/$(dirname "$f")"
  cp "/tests/files/$f" "/app/$f"
done < /tests/files.txt

export CI=1
reward=0
# The agent edits the same tree the tests run in, so the runner's own
# configuration is off limits: a vitest.config.ts that excludes the hidden
# files, or a plugin that rewrites them, would score an unfixed task. The
# baseline copies sit beside the hidden tests, which the agent cannot reach;
# the tree's own git is not the baseline, since the agent can commit to it.
# None of the real fixes touched these files.
refused=0
for f in vitest.config.ts package.json pnpm-workspace.yaml pnpm-lock.yaml; do
  if [ -f "/tests/baseline/$f" ]; then
    cmp -s "/tests/baseline/$f" "/app/$f" || refused=1
  elif [ -e "/app/$f" ]; then
    refused=1
  fi
done
if [ "$refused" = 1 ]; then
  echo "the test configuration or the manifests differ from the base state" > /logs/verifier/refused.txt
elif pnpm build > /logs/verifier/build.log 2>&1; then
  # A JSON report, then a check that every hidden file was collected and
  # passed: an exit code alone cannot tell "all green" from "none ran".
  if pnpm exec vitest run --reporter=json --outputFile=/logs/verifier/vitest.json $(tr '\n' ' ' < /tests/files.txt) > /logs/verifier/vitest.log 2>&1 \
    && node /tests/collected.mjs /logs/verifier/vitest.json /tests/files.txt > /logs/verifier/collected.log 2>&1; then
    if pnpm -r typecheck > /logs/verifier/typecheck.log 2>&1; then
      reward=1
    fi
  fi
fi
echo "$reward" > /logs/verifier/reward.txt
