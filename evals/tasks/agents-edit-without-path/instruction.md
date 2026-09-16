The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## Problem

The Leglas runner needs to detect when an agent has edited a file. It does this by searching for the word "editing" in the activity label returned by the `activityFrom` function. This label describes what the agent is currently doing based on the event stream it produces. The UI displays the label to show progress and status; more importantly, the runner uses the label to decide whether to rerun a session on top of its own changes.

Cursor's agent sends `editToolCall` events when it edits a file. The file path is supposed to sit in `tool_call.editToolCall.args.path`. However, in some cases the path is missing or cannot be resolved. This can happen when the edit is attempted but the path argument was not provided, or when a relative path cannot be converted to an absolute path without the correct working directory context.

Currently, when the path is missing or unresolvable, the `cursorActivity` function returns the label "using write". This breaks the runner's detection mechanism. When a Cursor session ends, the runner checks the activity labels to see if the session edited any files. If the label says "using write" instead of something containing "editing", the runner fails to recognize that a file was edited. As a result, it reruns the session on top of its own edit, causing data loss.

The correct behavior is to return a label that contains the word "editing" even when the file path cannot be determined. Successful edits should still report the actual file path when available, but edit attempts without a resolvable path should still be recognizable as edits.

## Files

The buggy behavior is in `packages/server/src/agents.ts`, specifically in the `cursorActivity` function that handles edit tool calls. This function is called by the exported `activityFrom` function.

## Interfaces

The `activityFrom` function is exported from agents.ts and has this signature: `function activityFrom(vendor: string, event: string, cwd?: string): string | null`. The function must continue to work correctly for all existing cases.

The hidden test will invoke `activityFrom("cursor", eventString)` where the eventString is a JSON object containing an `editToolCall` with either missing `args` or `args` with no `path` field. The function should return the label "editing a file" in both cases.
