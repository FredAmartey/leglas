FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.20.0

# The repository at the commit just before the fix, with its history cut
# off there so the fix cannot be read back out of git.
RUN git clone --quiet https://github.com/FredAmartey/leglas.git /app \
  && cd /app \
  && git checkout --quiet 26f9e50a416e0a7a93a3781038c15b8184d17ff4 \
  && rm -rf .git \
  && git init --quiet \
  && git add -A \
  && git -c user.name=leglas -c user.email=leglas@localhost commit --quiet -m "leglas at 26f9e50a416e0a7a93a3781038c15b8184d17ff4"

WORKDIR /app
# The lockfile is frozen, so pnpm's release-age policy check adds nothing
# here and its per-package metadata fetches are what make a build time out.
RUN pnpm install --frozen-lockfile --config.minimum-release-age=0 && pnpm build
