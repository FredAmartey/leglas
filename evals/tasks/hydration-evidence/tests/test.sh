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
# A package the base commit did not have would still be picked up by the
# workspace glob and have its scripts run, and a second runner config beside
# the guarded one could take its place, so anything of either kind that has
# no baseline copy is refused too.
unchanged() {
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cmp -s "/tests/baseline/$f.snapshot" "/app/$f" || return 1
  done < /tests/baseline.txt
  for f in packages/*/package.json packages/*/.npmrc .npmrc .pnpmfile.cjs vitest.config.* vitest.workspace.* vite.config.*; do
    [ -e "$f" ] || continue
    [ -f "/tests/baseline/$f.snapshot" ] || return 1
  done
  return 0
}
refuse() {
  echo "$1" > /logs/verifier/refused.txt
  echo 0 > /logs/verifier/reward.txt
  exit 0
}

unchanged || refuse "the test configuration or the manifests differ from the base state"
pnpm build > /logs/verifier/build.log 2>&1 || refuse "the build failed"
# The build ran project code, so the guarded files are checked again before
# anything trusts them. The hidden tests go back only now, after every
# package script has run, so nothing the build did can have touched them.
unchanged || refuse "the test configuration or the manifests were changed by the build"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "/app/$(dirname "$f")"
  cp "/tests/files/$f" "/app/$f"
done < /tests/files.txt
# A JSON report, then a check that every hidden file was collected and
# passed: an exit code alone cannot tell "all green" from "none ran".
pnpm exec vitest run --reporter=json --outputFile=/logs/verifier/vitest.json $(tr '\n' ' ' < /tests/files.txt) > /logs/verifier/vitest.log 2>&1 \
  || refuse "the hidden tests did not pass"
# The tests ran project code too: confirm the hidden files are still the
# protected copies before the report is believed.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  cmp -s "/tests/files/$f" "/app/$f" || refuse "a hidden test file was changed during the run"
done < /tests/files.txt
node /tests/collected.mjs /logs/verifier/vitest.json /tests/files.txt > /logs/verifier/collected.log 2>&1 \
  || refuse "a hidden test file was not collected or did not pass"
unchanged || refuse "the test configuration or the manifests were changed by the tests"
pnpm -r typecheck > /logs/verifier/typecheck.log 2>&1 || refuse "the typecheck failed"
reward=1
echo "$reward" > /logs/verifier/reward.txt
