The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## The bug

The share manager's create and stop methods have a race condition. When a user asks to stop a share while create() is still starting, before it has called `http.createServer` and bound a port, the stop() method sees `active === null` and returns immediately, believing the share is already stopped. Meanwhile, create() continues its async work (reading previews, detecting tunnels, binding a port) and eventually activates the share. The user's stop request is forgotten.

The observable failure: call manager.create() and then call manager.stop() before create completes, particularly while previews are still being fetched or a port is still being bound. The create should fail with a 409 status, indicating the share was stopped while starting. Instead, it succeeds and returns an active share, leaving no way to undo it.

## Expected behaviour

When stop() is called during the async setup phase of create(), before the share becomes active, the create method must detect this and fail gracefully. It should close any server it has opened, return a failed result with status 409 and error message "Sharing was stopped while it was starting.", and ensure manager.status() returns null after the failure.

The fix must detect that a stop occurred during the window between create() beginning and active becoming non-null, and coordinate cleanup so that either the create wins (activates the share) or the stop wins (share never activates), never both.

## Where to fix

The problem and fix belong in packages/server/src/share.ts, in the `createShareManager` function. Focus on the `create` and `stop` closures and how they coordinate.
