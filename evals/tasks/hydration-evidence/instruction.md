The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## The problem

The `hydrationEvidence` function in `packages/server/src/hydration.ts` detects when the browser logs indicate that a framework rebuilt the page after load, a hydration error. The function returns an object naming the framework and the error message, or null if no hydration error is present.

The function currently has two false-positive bugs that cause it to mistake unrelated errors for real hydration mismatches:

1. **React detection is too broad.** The regex `/Hydration failed/i` matches "Apollo Client: cache hydration failed, falling back to network" and similar cache/store rehydration messages that have nothing to do with screen markup. These libraries use "rehydrate" to describe recovering persisted state from storage, not rebuilding the DOM after a server render.

2. **The catch-all detection is too broad.** The regex for "the app" framework, which catches Angular and other errors, matches anything that says "hydrat" and one of "mismatch", "fail", "did not match", or "unexpected". This incorrectly flags Redux "failed to rehydrate state", Apollo cache failures, and React Query state recovery as screen markup mismatches.

The function should only recognize hydration evidence when the error specifically describes a mismatch between server-rendered markup and what the browser found: either an "expected X but found Y" pattern, or a "mismatch" on a named markup part (node, element, DOM, tag, text, attribute, server, client).

## Required behavior

The exported function `hydrationEvidence(messages: readonly string[])` takes an array of error messages and returns `{ framework, message } | null`. It should:

1. Recognize "Hydration failed because ..." as a React error (not all "Hydration failed" messages).
2. Recognize Angular errors in the form "NG0500: During hydration ... expected ... but found ...".
3. Reject Redux Persist, Apollo Client, and React Query rehydration messages as noise, they have nothing to do with screen markup.

The interface returned is `HydrationEvidence = { framework: string; message: string }`. The function must export both `HydrationEvidence` as a type and `hydrationEvidence` as a function.

When multiple messages are supplied, the function returns the first one that matches a hydration pattern, preserving its original text. Messages that arrive with stack traces should be trimmed to their first line before checking. An empty message list returns null.
