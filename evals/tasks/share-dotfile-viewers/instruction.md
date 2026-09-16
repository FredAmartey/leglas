The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

## The Bug

When a share/tunnel is active, the Leglas server allows viewers to access files from the project through the `/leglas/files/` endpoint. This is a security risk: viewers can currently request sensitive configuration files like `.env`, `.git/config`, `.ssh/id_rsa`, `.aws/credentials`, and other hidden files that store credentials, secrets, and system configuration.

An attacker can reach these files by simple request: `GET /leglas/files/.env` or through path traversal attacks like `GET /leglas/files/foo/../.env`, URL encoding like `GET /leglas/files/%2Eenv`, and backslash tricks like `GET /leglas/files/foo\..\\.env`.

## The Expected Behaviour

The server should refuse access to any path that contains a segment starting with a dot (a "hidden" segment), and do so in a way that handles all the encoding tricks above. It should return HTTP 403 with the error message `"Not available to viewers."` for such requests.

There is a constraint: the project uses Vite for dependency serving, and Vite stores essential files under dot directories in node_modules like `.vite/deps/...` and `.pnpm/...`. The solution must allow these to pass through so that viewers can actually load the app.

## Where to Fix

The file serving logic lives in `packages/server/src/share.ts` in the `createShareManager` function, in the file-request handler that serves viewers.

Export a function named `isHiddenPath` from `packages/server/src/share.ts` that takes the request path string and returns true when any spelling of it reaches for a hidden segment: URL-encoded forms, backslashes, path normalization and traversal sequences like `..` all count. The module already has a helper that enumerates the spellings of a path.

The file handler must refuse such a request with a 403 and the message above.

The boundary: dot segments like `.` and `..` used for path traversal do not count as "hidden" segments. Only segments that are actual directory or file names starting with a dot (like `.env`, `.git`, `.vite`, `.pnpm`) matter. And anything under node_modules, even if it starts with a dot, is allowed through because the dev server needs it.
