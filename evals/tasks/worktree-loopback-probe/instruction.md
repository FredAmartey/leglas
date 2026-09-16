The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## The Bug

When Leglas starts a development server for a worktree branch, it waits for the server to begin listening on the port it allocated, then reports the URL where the UI can reach it. The wait logic is in `packages/server/src/worktree.ts`, in the `startAppProcess` function. It tries to connect to a port and times out after ninety seconds if nothing answers.

On current macOS and Node.js, when a dev server is told to bind to `localhost`, it resolves that hostname and binds to whatever the system returns first. The system resolver returns `::1` (IPv6 loopback) first, so Vite's default configuration listens on IPv6 alone. The wait logic only probes `127.0.0.1` (IPv4 loopback). It therefore waits the full ninety seconds against a server that has been answering since its first second, then reports the server failed to start, even though it was running and serving the port the whole time. Every branch preview was deleted because of this timeout.

The same logic path applies to the project's own app when the config carries a `devCommand`, since that path also starts a dev process and waits for it using the same function.

## Required behaviour

The wait must find a dev server listening on either loopback address, `127.0.0.1` or `::1`, and the URL it reports must use whichever address answered. IPv6 addresses take bracket notation in URLs, `http://[::1]:port`, while IPv4 must not have brackets, `http://127.0.0.1:port`. The overall deadline stays at ninety seconds, or the `readyTimeoutMs` option when the caller passes one, and a server that is answering must be found well inside that.

## Where It Lives

The faulty logic is in `packages/server/src/worktree.ts`: the probe that `startAppProcess` waits on, and the code that builds the returned URL from it.

## Test Expectations

The hidden tests create IPv6-only and IPv4-only HTTP servers and call `startAppProcess` with `devCommand` pointing to a tiny server script that listens on the address given to it. The tests verify that the function finds the server, does not time out, and returns a URL that reaches the server. The URL for an IPv6-only server must contain `[::1]`, and the URL for an IPv4-only server must contain `127.0.0.1`.
