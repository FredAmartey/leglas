# Contributing

Leglas is a pnpm workspace. Node 24 or newer.

```sh
pnpm install
pnpm build       # build every package
pnpm test        # the suite, build included
pnpm typecheck   # every package
pnpm site        # the homepage and changelog, into dist/site
```

| Package           | Contents                                           |
| ----------------- | -------------------------------------------------- |
| `packages/server` | Config loading, the proxy and the local server     |
| `packages/shell`  | The interface, a React application built with Vite |
| `packages/cli`    | The `leglas` binary                                |
| `packages/mcp`    | The `leglas-mcp` stdio server for agent hosts      |

## Working on it

To try a change against a real app, build, then run the built CLI from
that app's directory:

```sh
pnpm build
cd ../some-app && node ../leglas/packages/cli/dist/bin.js
```

To work on the interface with live reload, run a Leglas server in one
terminal and `pnpm --filter @leglas/shell dev` in another.

## Before opening a pull request

- `pnpm test` and `pnpm typecheck` pass.
- If your change touches what the packages export, run `pnpm api:update`
  and commit `api-surface.txt`. It is the record of the public surface, and
  a patch release is refused when it has moved since the previous one.
- Add an entry to the Unreleased section of `CHANGELOG.md`. Say what
  changed and why in plain words, and end it the way the existing entries
  do, with the name of what it reaches in backticks and parentheses: the
  CLI, the MCP server or the plugin. The changelog page on the site is made
  from that file and nothing else, so the entry is the whole job of
  describing the change.
- A change to the interface comes with a screenshot of it, before and
  after where that helps.

## Pull requests

Say what changed and why, and what you ran to check it. Keep the change to
the one thing the title names. A maintainer may run an automated review on
the pull request; it answers only to people with write access, so do not
wait on it.

## Versions

Leglas numbers releases by pride. Bump the first number for a release you
are proud of, the second for an ordinary one, the third for a fix too
embarrassing to admit. The workflow adds one rule to that: a third-number
tag is refused when the public surface moved since the last one, because a
fix that changes what importers depend on is not a fix.

## Releases

Releases are cut by maintainers and are tag-driven: set the same version
in both packages and `plugin.json`, turn the changelog's Unreleased section
into that version with a title for what the release was about, push a
`v<version>` tag, and CI runs the suite and publishes through npm trusted
publishing. A tag that disagrees with the manifests is refused. No npm
token exists anywhere in the project.

The [site](https://leglas.vercel.app/) is two pages, the homepage and the
[changelog](https://leglas.vercel.app/changelog/), written by `site.ts` and
built by Vercel from `vercel.json` on every push. `main` is the live site,
and every pull request gets a preview.
