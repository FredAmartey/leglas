# anti-slop

Vendored Oxlint rules from https://github.com/dmmulroy/anti-slop.

- Source: `dmmulroy/anti-slop`, commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
  (2026-09-10). The files here are byte-identical to
  `skills/install-anti-slop/assets/anti-slop/` at that commit, which is the
  repository's `src/` without its tests.
- Installed: 2026-09-22 with the `install-anti-slop` skill's copy script.
- Entry points: `index.ts` (generic rules, registered as `anti-slop` in
  `.oxlintrc.json`). `effect/index.ts` is copied but not registered, since
  this repository does not depend on Effect.
- Runtime: `oxlint` and `@oxlint/plugins`, both pinned to the same exact
  version in the root `package.json`. Move them together.
- License: MIT, in `LICENSE` beside this file, copied from upstream.
- Local changes: none.

`vendor/eslint-stylistic/` carries its own `LICENSE` and `UPSTREAM.md` and
travels with `require-readable-spacing`.

To update, ask an agent to update anti-slop while preserving local
customizations; the skill's update procedure does a three-way merge against
the commit above.
