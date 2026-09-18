The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## The Problem

The interface blanks when a branch preview exists but has not started yet. The browser console shows a TypeError: "Cannot read properties of undefined (reading 'startsWith')".

Branch previews are directions that are being set up through the Leglas CLI; they have a title and other metadata but the URL field is undefined until the preview becomes ready. The `scanQueue` function in `packages/shell/src/scan.ts` filters previews to determine which ones need to be read in the background to check for duplicate designs. When a branch preview with an undefined URL reaches this function, the code crashes instead of skipping it gracefully.

## Expected Behavior

When a preview has no URL (undefined), the `scanQueue` function should filter it out and continue without throwing an error. The preview should be skipped rather than crashing the interface.

## Context

The `scanQueue` function in `packages/shell/src/scan.ts` filters an array of previews and returns only those that need a background scan. It checks whether each preview's URL is a same-origin path and whether its current scan status is still pending. The function receives a readonly array of Preview objects.

The Preview type is imported from `./types.js` and includes a `url` property. In normal operation, `url` is always a string (either a local path starting with "/" or a cross-origin URL). However, a branch preview in the initial state can have `url: undefined` because the URL is assigned only after the branch becomes ready.

The filter currently assumes `url` is always a string and calls `.startsWith()` on it directly. This assumption fails for branch previews that have not started.
