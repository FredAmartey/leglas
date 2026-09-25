import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { GENERATION_EFFORT } from "./claude.js";

import { isJsonRecord, isString, parseJson } from "../json.js";

/**
 * Codex as a generation agent, the counterpart of `claude.ts`.
 *
 * Measured on codex-cli 0.155.1 (2026-09-25) with the same three-direction
 * benchmark: 130 seconds for the set where Claude took about 86, three
 * strong, genuinely different designs, no fix runs. These flags keep a run to
 * what Leglas tells it: nothing kept on disk, the project's AGENTS.md and the
 * person's skills, plugins, memories and helper agents left out. One thing
 * cannot be left out: Codex always reads the global AGENTS.md in its home.
 */
const RESTRICTED = [
  "exec",
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "-c",
  `model_reasoning_effort=${GENERATION_EFFORT}`,
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  "skills.include_instructions=false",
  "-c",
  "skills.bundled.enabled=false",
  // Through the config, not `--disable`: a Codex that lacks one of these
  // ignores it here, where `--disable` refuses to start at all.
  ...[
    "multi_agent",
    "apps",
    "plugins",
    "memories",
    "goals",
    "browser_use",
    "computer_use",
    "image_generation",
  ].flatMap((feature) => ["-c", `features.${feature}=false`]),
];

/** A key Codex's `-c` accepts bare; a quoted one makes a second, broken server instead. */
const BARE = /^[A-Za-z0-9_-]+$/;

/**
 * The MCP servers the person's Codex config defines. `-c mcp_servers={}`
 * leaves them all in place, so each is switched off by name; without that a
 * set of three started every server four times over, and their start-up
 * errors filled the lines a failure is read from.
 */
export async function codexServers(home: string = defaultCodexHome()): Promise<string[]> {
  let config: string;

  try {
    config = await readFile(join(home, "config.toml"), "utf8");
  } catch {
    return [];
  }

  const names = new Set<string>();

  for (const match of config.matchAll(
    /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/gm,
  )) {
    const name = match[1] ?? match[2] ?? match[3] ?? "";

    if (BARE.test(name)) names.add(name);
  }

  return [...names];
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME !== undefined && env.CODEX_HOME !== ""
    ? env.CODEX_HOME
    : join(homedir(), ".codex");
}

const serversOff = (servers: readonly string[]): string[] =>
  servers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);

/** The planner reads nothing and writes nothing. */
export function codexPlanArgs(prompt: string, servers: readonly string[]): string[] {
  return [...RESTRICTED, ...serversOff(servers), "-s", "read-only", prompt];
}

/** A builder writes inside the project and nowhere else. */
export function codexBuildArgs(prompt: string, servers: readonly string[]): string[] {
  return [...RESTRICTED, ...serversOff(servers), "-s", "workspace-write", prompt];
}

/**
 * The final answer in a Codex JSONL transcript: its last agent message.
 * Codex also reports its own warnings as items, so only a message counts.
 */
export function codexResultText(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";

    if (!line.startsWith("{")) continue;

    try {
      const event = parseJson(line);
      const item = isJsonRecord(event) ? event.item : undefined;

      if (
        isJsonRecord(event) &&
        event.type === "item.completed" &&
        isJsonRecord(item) &&
        item.type === "agent_message" &&
        isString(item.text)
      )
        return item.text;
    } catch {
      // Codex's own log lines share the stream; the answer is the JSON.
    }
  }

  return null;
}
