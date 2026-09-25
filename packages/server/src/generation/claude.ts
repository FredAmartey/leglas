import type { AgentEffort } from "../agents/agents.js";

import { isJsonRecord, isString, parseJson } from "../json.js";

/**
 * The effort every generation run uses, whatever the person's agent is set to.
 *
 * Measured on three directions (2026-09-23): max took 34 minutes and 444k
 * output tokens, medium 86 seconds and 19k. Anthropic's docs put max thinking
 * beyond any bound, and the one hard cap, max_tokens, cuts the file off
 * unwritten. Nobody should wait half an hour for a draft, so Leglas sets the
 * effort for these runs itself.
 */
export const GENERATION_EFFORT: AgentEffort = "medium";

/**
 * A run that sees only what Leglas tells it. Restricted mode skips the
 * person's settings, hooks, CLAUDE.md and skills, which on one measured
 * machine sent builders off loading skills and reading the tool's own source;
 * with the listed tools and nothing else, a build took 3 model calls.
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
      // A line that is not JSON is the CLI's own chatter; the result event is.
    }
  }

  return null;
}
