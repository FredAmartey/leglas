#!/usr/bin/env bash
# Verifier: put the hidden tests back, build, run them, typecheck.
# Reward is 1 only when every step passes.
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
if pnpm build > /logs/verifier/build.log 2>&1; then
  if pnpm exec vitest run $(tr '\n' ' ' < /tests/files.txt) > /logs/verifier/vitest.log 2>&1; then
    if pnpm -r typecheck > /logs/verifier/typecheck.log 2>&1; then
      reward=1
    fi
  fi
fi
echo "$reward" > /logs/verifier/reward.txt
