---
name: leglas
description: Use when the user asks for design variations, directions, alternatives, or "a few options" for a page, component, screen, or user flow; wants to compare designs side by side as the real running app instead of mockups; asks to A/B or explore visual ideas live; or mentions Leglas, a design rail, or keeping a winning direction.
homepage: https://github.com/FredAmartey/leglas
repository: https://github.com/FredAmartey/leglas
license: MIT
user-invocable: true
---

# Leglas

Leglas compares design directions inside the running app. Each direction
is a URL of the user's own dev server; Leglas proxies them side by side
in one interface, so choosing between two ideas is choosing between two
things that already exist. Your job is to build the directions. Leglas
holds the comparison.

## The one rule

**Add beside what exists. Never rewrite it.** Every direction renders
from the one dev server that is already running. Two directions that
rewrite the same file cannot coexist, and asked for "a calmer hero,"
your instinct is to edit the hero. Resist it. New files beside the old,
one per direction, switched by URL.

## Setup

Check whether the project's `AGENTS.md` contains a "Design directions
(Leglas)" section. If it does, that section is the source of truth for
this project: follow it, not this file.

If it does not:

1. Run `npx leglas init` from the project root. It writes the workflow
   section into `AGENTS.md`, creates a starter `leglas.config.ts`, and
   gitignores the working directory. Needs Node 24+.
2. Read the section it wrote and follow it.
3. If the interface is not already running, tell the user to run
   `npx leglas` and give them `http://localhost:4100/leglas` now, not
   when the set is done. The rail fills in as each direction registers.

## Orientation

- `leglas explore <surface> --count <n>` briefs an exploration before
  you build it. Run it first; it tells you what the set needs.
- Every command accepts `--json` and prints one machine-readable
  envelope with a stable exit code.
- `leglas requests --json` holds change requests the user typed into
  the interface, each naming the direction and the file behind it.
- For agent hosts that cannot run shell commands, the `leglas-mcp`
  server exposes the same operations as MCP tools over stdio.
