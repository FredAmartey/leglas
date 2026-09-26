import type { AgentEffort } from "../agents/agents.js";

import { isJsonRecord, isString, parseJson } from "../json.js";

/**
 * The effort every generation run uses, whatever the agent is set to. On three
 * directions (2026-09-23): max took 34 minutes and 444k output tokens, medium
 * 86 seconds and 19k. Max thinking has no bound and max_tokens cuts the file
 * off, so Leglas sets it.
 */
export const GENERATION_EFFORT: AgentEffort = "medium";

/**
 * Restricted mode skips the person's settings, hooks, CLAUDE.md and skills,
 * which sent builders off loading skills and reading the tool's own source on
 * one machine. With just the listed tools a build took 3 model calls.
 */
const RESTRICTED = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--restricted",
  "--strict-mcp-config",
];

/** The planner only answers: no tools at all. */
export function planArgs(prompt: string, effort: AgentEffort = GENERATION_EFFORT): string[] {
  return ["-p", prompt, ...RESTRICTED, "--tools", "", "--effort", effort];
}

/** A builder reads its placeholder once and writes its one file. */
export function buildArgs(prompt: string, effort: AgentEffort = GENERATION_EFFORT): string[] {
  return [
    "-p",
    prompt,
    ...RESTRICTED,
    "--tools",
    "Read,Write,Edit",
    "--permission-mode",
    "acceptEdits",
    "--effort",
    effort,
  ];
}

/** The final answer in a stream-json transcript: its last `result` event. */
export function resultText(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";

    if (!line.startsWith("{")) continue;

    try {
      const event = parseJson(line);

      if (isJsonRecord(event) && event.type === "result" && isString(event.result))
        return event.result;
    } catch {
      // Not JSON: the CLI's own chatter, never the result.
    }
  }

  return null;
}
