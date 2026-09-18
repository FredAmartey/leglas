#!/usr/bin/env bash
# Verifier: check the base state, build, put the hidden tests back, run
# them, typecheck. Reward is 1 only when every step passes and every hidden
# test file ran.
set -u
mkdir -p /logs/verifier
cd /app

export CI=1
reward=0
# The agent edits the same tree the tests run in, so the files that decide
# what build, typecheck and vitest mean are off limits: a vitest.config.ts
# that excludes the hidden files, a package script turned into true, a
# loosened tsconfig. The baseline copies sit beside the hidden tests, which
# the agent cannot reach; the tree's own git is not the baseline, since the
# agent can commit to it. None of the real fixes touched these files.
refused=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  cmp -s "/tests/baseline/$f" "/app/$f" || refused=1
done < /tests/baseline.txt
# A package the base commit did not have would still be picked up by the
# workspace glob and have its scripts run, and a second runner config beside
# the guarded one could take its place, so anything of either kind that has
# no baseline copy is refused too.
for f in packages/*/package.json vitest.config.* vitest.workspace.* vite.config.*; do
  [ -e "$f" ] || continue
  [ -f "/tests/baseline/$f" ] || refused=1
done
if [ "$refused" = 1 ]; then
  echo "the test configuration or the manifests differ from the base state" > /logs/verifier/refused.txt
elif pnpm build > /logs/verifier/build.log 2>&1; then
  # The hidden tests go back only now, after every package script has run,
  # so nothing the build did can have touched them.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    mkdir -p "/app/$(dirname "$f")"
    cp "/tests/files/$f" "/app/$f"
  done < /tests/files.txt
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
