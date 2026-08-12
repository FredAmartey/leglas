import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { WATCH_PATH } from "./agent-command.js";

/**
 * Whether a CLI's saved login will actually carry a run. "ok" and
 * "signed-out" are the CLI's own answer; "unknown" is everything else: no
 * status command reached, output we don't understand, a probe that timed
 * out. Unknown never blocks anything, because a wrong "signed out" would
 * box a user out of an agent that works.
 */
export type AgentAuth = "ok" | "signed-out" | "unknown";

type ProbeResult = { code: number; stdout: string };

// `args` feeds the embedded runner's JSONL parser, while `terminalArgs` feeds
// a human-watched terminal. Keep the pair in step when an agent's CLI changes.
// `authArgs` asks the CLI whether its login is live, and `authVerdict` reads
// the answer; both are per-vendor because no two CLIs agree on the surface.
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
    authArgs: ["auth", "status"],
    // `claude auth status` prints JSON with a loggedIn boolean. Only that
    // field decides; any other shape stays unknown.
    authVerdict: (result: ProbeResult): AgentAuth => {
      try {
        const parsed = record(JSON.parse(result.stdout));
        if (parsed?.loggedIn === true) return "ok";
        if (parsed?.loggedIn === false) return "signed-out";
      } catch {
        // Older CLIs may not know the subcommand or may print prose.
      }
      return "unknown";
    },
  },
  codex: {
    name: "Codex",
    binary: "codex",
    args: (prompt: string): string[] => ["exec", "--json", "-s", "workspace-write", prompt],
    terminalArgs: (prompt: string): string[] => ["exec", "-s", "workspace-write", prompt],
    authArgs: ["login", "status"],
    // `codex login status` exits 0 when logged in and nonzero when not.
    authVerdict: (result: ProbeResult): AgentAuth =>
      result.code === 0 ? "ok" : "signed-out",
  },
  cursor: {
    name: "Cursor",
    binary: "cursor-agent",
    args: (prompt: string): string[] => ["-p", prompt, "--output-format", "stream-json"],
    terminalArgs: (prompt: string): string[] => ["-p", prompt],
    authArgs: ["status"],
    // UNVERIFIED: cursor-agent was not available on the build machine. The
    // reading is deliberately loose, and anything ambiguous stays unknown.
    authVerdict: (result: ProbeResult): AgentAuth => {
      if (/logged in|signed in/i.test(result.stdout)) return "ok";
      if (result.code !== 0 || /not logged in|log in|sign in/i.test(result.stdout))
        return "signed-out";
      return "unknown";
    },
  },
} as const;

export type KnownAgentId = keyof typeof KNOWN_AGENTS;
export type AgentChoice = KnownAgentId | "custom";
export type DetectedAgent = {
  id: KnownAgentId;
  name: string;
  available: boolean;
  auth: AgentAuth;
};

export type SavedAgentChoice = {
  agent: AgentChoice | null;
  run: string | null;
};

export type AgentChoiceInput = {
  agent: AgentChoice;
  run?: string;
};

type BinaryLookup = (binary: string) => Promise<boolean>;

export type AuthProbe = (
  binary: string,
  args: readonly string[],
) => Promise<ProbeResult | null>;

const PROBE_TIMEOUT_MS = 3000;

/**
 * One status command, capped stdout, hard deadline. A CLI that hangs on its
 * own status question must never hold the agents endpoint hostage; it just
 * reads as unknown.
 */
function execProbe(binary: string, args: readonly string[]): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve(null);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve(signal !== null ? null : { code: code ?? 0, stdout });
    });
  });
}

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

/**
 * Report every built-in adapter: whether its binary can be executed, and
 * whether its login is live. Probes run in parallel, so the wall-clock cost
 * is the slowest vendor's status command, about a second, and the caller is
 * expected to cache the answer rather than pay it per request.
 */
export async function detectAgents(
  lookup: BinaryLookup = pathLookup,
  probe: AuthProbe = execProbe,
): Promise<DetectedAgent[]> {
  const entries = Object.entries(KNOWN_AGENTS) as [KnownAgentId, (typeof KNOWN_AGENTS)[KnownAgentId]][];
  return Promise.all(
    entries.map(async ([id, adapter]) => {
      const available = await lookup(adapter.binary).catch(() => false);
      if (!available) return { id, name: adapter.name, available, auth: "unknown" as const };
      const result = await probe(adapter.binary, adapter.authArgs).catch(() => null);
      return {
        id,
        name: adapter.name,
        available,
        auth: result === null ? ("unknown" as const) : adapter.authVerdict(result),
      };
    }),
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
