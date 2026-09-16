The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

The `isDevControlRequest()` function in `packages/server/src/share.ts` determines whether a request path is one of the dangerous development-server control routes that should never be accessible to viewers. It rejects paths like `/__open-in-editor`, `/__devtools__`, and any route that a dev server would recognize and act upon.

Currently, the function uses an internal `spellings()` helper to generate all possible normalized versions of a path that a server might see. The function checks case variations, URL-decoding, multiple-slash collapsing, and POSIX path normalization.

The bug: Node's own URL parsers treat backslashes as forward slashes when normalizing paths. Both the legacy `url.parse()` and the WHATWG `URL` API convert `/foo\..\\__open-in-editor` to `/foo/../__open-in-editor`, which normalizes to `/__open-in-editor`. Dev servers that use either of these parsers see the normalized form, but the current `spellings()` function does not generate backslash variants, so it fails to recognize these attack paths.

Paths that must be rejected include:
- `/foo\..\\__open-in-editor` (backslashes in the path)
- `/\\__open-in-editor` (backslash as first separator)
- `/foo%5C..%5C__open-in-editor` (URL-encoded backslashes: `%5C` = `\`)
- `/foo\\../__OPEN-IN-EDITOR` (mixed backslashes and forward slashes)

Whatever spelling a Node-based dev server would normalize to a refused control route, `isDevControlRequest()` must refuse as well. The `spellings()` helper in `packages/server/src/share.ts` is where the module enumerates the forms a path can take.
