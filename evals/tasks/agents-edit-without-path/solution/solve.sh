#!/usr/bin/env bash
set -euo pipefail
cd /app
git apply --whitespace=nowarn /solution/fix.patch
