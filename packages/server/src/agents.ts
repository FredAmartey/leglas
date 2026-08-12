import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { WATCH_PATH } from "./agent-command.js";

// `args` feeds the embedded runner's JSONL parser, while `terminalArgs` feeds
// a human-watched terminal. Keep the pair in step when an agent's CLI changes.
export const KNOWN_AGENTS = {
  claude: {
    name: "Claude",
    binary: "claude",
    args: (prompt: string): string[] => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ],
    terminalArgs: (prompt: string): string[] => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
    ],
  },
  codex: {
    name: "Codex",
    binary: "codex",
    args: (prompt: string): string[] => ["exec", "--json", "-s", "workspace-write", prompt],
    terminalArgs: (prompt: string): string[] => ["exec", "-s", "workspace-write", prompt],
  },
  cursor: {
    name: "Cursor",
    binary: "cursor-agent",
    args: (prompt: string): string[] => ["-p", prompt, "--output-format", "stream-json"],
    terminalArgs: (prompt: string): string[] => ["-p", prompt],
  },
} as const;

export type KnownAgentId = keyof typeof KNOWN_AGENTS;
export type AgentChoice = KnownAgentId | "custom";
export type DetectedAgent = { id: KnownAgentId; name: string; available: boolean };

export type SavedAgentChoice = {
  agent: AgentChoice | null;
  run: string | null;
};

export type AgentChoiceInput = {
  agent: AgentChoice;
  run?: string;
};

type BinaryLookup = (binary: string) => Promise<boolean>;

async function pathLookup(binary: string): Promise<boolean> {
  const entries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry !== "")
      : [""];

  for (const entry of entries) {
    for (const extension of extensions) {
      try {
        await access(join(entry, `${binary}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Another PATH entry may still contain the binary.
      }
    }
  }
  return false;
}

/** Report every built-in adapter and whether its binary can be executed. */
export async function detectAgents(lookup: BinaryLookup = pathLookup): Promise<DetectedAgent[]> {
  const entries = Object.entries(KNOWN_AGENTS) as [KnownAgentId, (typeof KNOWN_AGENTS)[KnownAgentId]][];
  return Promise.all(
    entries.map(async ([id, adapter]) => ({
      id,
      name: adapter.name,
      available: await lookup(adapter.binary).catch(() => false),
    })),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shownPath(value: unknown, cwd: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!isAbsolute(value)) return value;
  return relative(cwd, value) || ".";
}

/**
 * The command itself, cleaned for a status line: the shell wrapper agents
 * put around everything says nothing, and the first 48 characters of what
 * remains say everything ("npm test", "grep -r Hero src"). "running a
 * command" was the label before, and it managed to be true of every command
 * while describing none of them.
 */
function shownCommand(value: unknown): string | null {
  let command = Array.isArray(value)
    ? value.filter((part) => typeof part === "string").join(" ")
    : typeof value === "string"
      ? value
      : "";
  command = command.trim();

  const wrapped = /^(?:bash|sh|zsh)\s+-l?c\s+([\s\S]*)$/.exec(command);
  if (wrapped?.[1] !== undefined) {
    command = wrapped[1].trim();
    const quote = command[0];
    if ((quote === "'" || quote === '"') && command.endsWith(quote) && command.length > 1) {
      command = command.slice(1, -1);
    }
  }

  command = (command.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (command === "") return null;
  return command.length > 48 ? `${command.slice(0, 47)}…` : command;
}

function claudeActivity(event: Record<string, unknown>, cwd: string): string | null {
  if (event.type !== "assistant") return null;
  const message = record(event.message);
  if (message === null || !Array.isArray(message.content)) return null;

  for (const rawBlock of message.content) {
    const block = record(rawBlock);
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;

    const input = record(block.input);
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name)) {
      const path = shownPath(input?.file_path ?? input?.notebook_path, cwd);
      return path === null ? `using ${block.name}` : `editing ${path}`;
    }
    if (block.name === "Read") {
      const path = shownPath(input?.file_path ?? input?.path, cwd);
      return path === null ? "using Read" : `reading ${path}`;
    }
    if (block.name === "Bash") {
      const command = shownCommand(input?.command);
      return command === null ? "running a command" : `running ${command}`;
    }
    if (block.name === "Grep" || block.name === "Glob") return "searching the project";
    return `using ${block.name}`;
  }
  return null;
}

function codexActivity(event: Record<string, unknown>, cwd: string): string | null {
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = record(event.item);
  if (item === null) return null;

  if (item.type === "command_execution") {
    const command = shownCommand(item.command);
    return command === null ? "running a command" : `running ${command}`;
  }
  if (item.type !== "file_change") return null;

  const first = Array.isArray(item.changes) ? record(item.changes[0]) : null;
  const path = shownPath(first?.path ?? item.path, cwd);
  return path === null ? null : `editing ${path}`;
}

/** Reduce one agent JSONL event to a short, user-facing activity label. */
export function activityFrom(
  agent: AgentChoice,
  line: string,
  cwd = process.cwd(),
): string | null {
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (event === null) return null;

  if (agent === "claude") return claudeActivity(event, cwd);
  if (agent === "codex") return codexActivity(event, cwd);
  // Cursor's stream-json mapping is unverified because cursor-agent was not
  // available during this slice. Its documented shape matches Claude's.
  if (agent === "cursor") return claudeActivity(event, cwd);
  return null;
}

function isAgentChoice(value: unknown): value is AgentChoice {
  return value === "custom" || (typeof value === "string" && Object.hasOwn(KNOWN_AGENTS, value));
}

async function readWatchConfig(cwd: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, WATCH_PATH), "utf8")) as unknown;
    return record(parsed) ?? {};
  } catch {
    return {};
  }
}

export async function readAgentChoice(cwd: string): Promise<SavedAgentChoice> {
  const config = await readWatchConfig(cwd);
  return {
    agent: isAgentChoice(config.agent) ? config.agent : null,
    run: typeof config.run === "string" && config.run !== "" ? config.run : null,
  };
}

/** Save only the fields this choice owns, leaving the watch template and future fields intact. */
export async function saveAgentChoice(cwd: string, choice: AgentChoiceInput): Promise<void> {
  const config = await readWatchConfig(cwd);
  config.agent = choice.agent;
  if (choice.run !== undefined) config.run = choice.run;

  const path = join(cwd, WATCH_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
