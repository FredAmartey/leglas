FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@{{PNPM}}

# The repository at the commit just before the fix, with its history cut
# off there so the fix cannot be read back out of git.
RUN git clone --quiet {{REPO}} /app \
  && cd /app \
  && git checkout --quiet {{SHA}} \
  && rm -rf .git \
  && git init --quiet \
  && git add -A \
  && git -c user.name=leglas -c user.email=leglas@localhost commit --quiet -m "leglas at {{SHA}}"

WORKDIR /app
# The lockfile is frozen, so pnpm's release-age policy check adds nothing
# here and its per-package metadata fetches are what make a build time out.
RUN pnpm install --frozen-lockfile --config.minimum-release-age=0 && pnpm build
