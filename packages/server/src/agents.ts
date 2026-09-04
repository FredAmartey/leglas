import { spawn } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { WATCH_PATH } from "./agent-command.js";
import type { RetryNotice } from "./failure.js";

/**
 * Whether a CLI's saved login will actually carry a run. "ok" and
 * "signed-out" are the CLI's own answer; "unknown" is everything else: no
 * status command reached, output we don't understand, a probe that timed
 * out. Unknown never blocks anything, because a wrong "signed out" would
 * box a user out of an agent that works.
 */
export type AgentAuth = "ok" | "signed-out" | "unknown";

type ProbeResult = { code: number; stdout: string };

export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

const effortFlag = (effort: AgentEffort | null): string[] =>
  effort === null ? [] : ["--effort", effort];
const codexEffortConfig = (effort: AgentEffort | null): string[] =>
  effort === null ? [] : ["-c", `model_reasoning_effort=${effort}`];

/**
 * The embedded runner edits a live application. Workspace-write remains the
 * filesystem boundary, while loopback/network access lets Codex inspect the
 * dev server that is already running instead of trying and failing to boot a
 * second one. Model stays with the user's agent; reasoning effort is only
 * overridden when they explicitly choose one in Leglas.
 */
const CODEX_WORKSPACE_CONFIG = [
  "-c",
  "sandbox_workspace_write.network_access=true",
] as const;

// `args` feeds the embedded runner's JSONL parser, while `terminalArgs` feeds
// a human-watched terminal. Keep the pair in step when an agent's CLI changes.
// `authArgs` asks the CLI whether its login is live, and `authVerdict` reads
// the answer; both are per-vendor because no two CLIs agree on the surface.
// `resumeArgs` and `sessionFrom` exist where the vendor can continue a saved
// session: a resumed turn skips the repo survey the first turn already paid
// for, measured at 25-40% of a run's wall-clock.
export const KNOWN_AGENTS = {
  claude: {
    name: "Claude",
    binary: "claude",
    efforts: AGENT_EFFORTS,
    args: (prompt: string, effort: AgentEffort | null = null, _images: readonly string[] = []): string[] => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...effortFlag(effort),
    ],
    terminalArgs: (prompt: string, effort: AgentEffort | null = null, _images: readonly string[] = []): string[] => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      ...effortFlag(effort),
    ],
    resumeArgs: (
      sessionId: string,
      prompt: string,
      effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => [
      "-p",
      "--resume",
      sessionId,
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...effortFlag(effort),
    ],
    // Non-interactive Claude cannot approve a Bash call: acceptEdits covers
    // files, so a command the prompt requires is refused every time with
    // nobody there to say yes. This allows exactly that command and nothing
    // wider. Codex needs no equivalent, because workspace-write already lets
    // it run commands.
    allowArgs: (commands: readonly string[]): string[] => [
      "--allowedTools",
      ...commands.map((command) => `Bash(${command} *)`),
    ],
    activityVerified: true,
    // Every stream-json event names its session.
    sessionFrom: (event: Record<string, unknown>): string | null =>
      typeof event.session_id === "string" && event.session_id !== "" ? event.session_id : null,
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
    efforts: AGENT_EFFORTS,
    // `--skip-git-repo-check` is what lets Codex run at all in a project the
    // user never put under version control: without it codex-cli refuses
    // before it reaches a model, with "Not inside a trusted directory and
    // --skip-git-repo-check was not specified", and every Codex request in a
    // non-git project fails for a reason nothing in Leglas explained. The flag
    // moves that precondition and only that: `-s workspace-write` still
    // confines writes to the project, so the sandbox boundary is unchanged,
    // and in a git repository the flag does nothing at all.
    args: (prompt: string, effort: AgentEffort | null = null, images: readonly string[] = []): string[] => [
      "exec",
      "--json",
      ...CODEX_WORKSPACE_CONFIG,
      ...codexEffortConfig(effort),
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      ...images.flatMap((image) => ["-i", image]),
      prompt,
    ],
    terminalArgs: (prompt: string, effort: AgentEffort | null = null, images: readonly string[] = []): string[] => [
      "exec",
      ...CODEX_WORKSPACE_CONFIG,
      ...codexEffortConfig(effort),
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      ...images.flatMap((image) => ["-i", image]),
      prompt,
    ],
    // No sandbox flag here: `codex exec resume` refuses it and inherits the
    // session's own sandbox, which the first turn set to workspace-write. The
    // repository check is per invocation, so resume needs the flag of its own.
    resumeArgs: (
      sessionId: string,
      prompt: string,
      effort: AgentEffort | null = null,
      images: readonly string[] = [],
    ): string[] => [
      "exec",
      "resume",
      sessionId,
      "--json",
      ...CODEX_WORKSPACE_CONFIG,
      ...codexEffortConfig(effort),
      "--skip-git-repo-check",
      ...images.flatMap((image) => ["-i", image]),
      prompt,
    ],
    sessionFrom: (event: Record<string, unknown>): string | null =>
      event.type === "thread.started" && typeof event.thread_id === "string"
        ? event.thread_id
        : null,
    activityVerified: true,
    authArgs: ["login", "status"],
    // `codex login status` exits 0 when logged in and nonzero when not.
    authVerdict: (result: ProbeResult): AgentAuth =>
      result.code === 0 ? "ok" : "signed-out",
  },
  cursor: {
    name: "Cursor",
    binary: "cursor-agent",
    efforts: [] as readonly AgentEffort[],
    args: (prompt: string, _effort: AgentEffort | null = null, _images: readonly string[] = []): string[] => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ],
    terminalArgs: (prompt: string, _effort: AgentEffort | null = null, _images: readonly string[] = []): string[] => ["-p", prompt],
    // `--resume [chatId]` is documented alongside `--continue` in the CLI
    // parameter reference, and every stream-json event carries the
    // `session_id` to feed it. Cursor exposes no persistent transport the way
    // Claude and Codex do, so its process still starts per request; what this
    // buys is the same thing a resumed turn buys them, skipping the repo
    // survey the first turn already paid for.
    //
    // Images are accepted and ignored, like its other argument builders:
    // `cursor-agent` documents no flag for them, and the capture paths reach
    // it as text in the prompt either way.
    resumeArgs: (
      sessionId: string,
      prompt: string,
      _effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => ["-p", "--resume", sessionId, prompt, "--output-format", "stream-json"],
    sessionFrom: (event: Record<string, unknown>): string | null =>
      typeof event.session_id === "string" && event.session_id !== "" ? event.session_id : null,
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
/**
 * Whether Leglas can tell from a vendor's output that it edited a file.
 *
 * Only a vendor whose event shape has been read against the real CLI carries
 * this. It gates the runner's one cold rerun after a dead session: rerunning
 * a run that had already edited can stack half-applied changes, so a vendor
 * whose edits Leglas cannot see is never rerun on its own.
 */
export function activityVerified(agent: AgentChoice): boolean {
  if (agent === "custom") return false;
  const adapter = KNOWN_AGENTS[agent];
  return "activityVerified" in adapter && adapter.activityVerified === true;
}

export type DetectedAgent = {
  id: KnownAgentId;
  name: string;
  available: boolean;
  auth: AgentAuth;
  efforts: readonly AgentEffort[];
};

export type SavedAgentChoice = {
  agent: AgentChoice | null;
  effort: AgentEffort | null;
  run: string | null;
};

export type AgentChoiceInput = {
  agent: AgentChoice;
  effort?: AgentEffort | null;
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
 *
 * The deadline answers as well as kills. "close" waits for the child's output
 * streams to end, not merely for the child to exit, so a wrapper script whose
 * own child outlives it keeps the pipe open and that event never arrives. The
 * kill alone then left this promise pending for good, and because the agents
 * endpoint holds one in-flight probe for the whole process, every later
 * request queued behind it: the chooser in the composer simply stopped
 * loading, for the life of the server.
 */
export function execProbe(
  binary: string,
  args: readonly string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], {
        env: agentEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve(null);
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
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

/**
 * The places agent CLIs commonly install themselves outside a service's PATH.
 *
 * A terminal normally inherits additions from .zprofile, .bashrc or a version
 * manager. A detached Leglas server does not, which made a CLI available in
 * the user's terminal disappear from the picker and then fail to spawn. Keep
 * the inherited PATH first, then add only conventional per-user and system
 * bin directories. Detection and execution both use this exact environment.
 */
export function agentSearchPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const npmPrefix = env.NPM_CONFIG_PREFIX;
  const versionBins = (root: string, suffix: readonly string[]): string[] => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, ...suffix));
    } catch {
      return [];
    }
  };
  const candidates = [
    ...(env.PATH ?? "").split(delimiter),
    env.PNPM_HOME,
    env.NVM_BIN,
    env.BUN_INSTALL === undefined ? undefined : join(env.BUN_INSTALL, "bin"),
    env.CARGO_HOME === undefined ? undefined : join(env.CARGO_HOME, "bin"),
    npmPrefix === undefined
      ? undefined
      : platform === "win32"
        ? npmPrefix
        : join(npmPrefix, "bin"),
    home === "" ? undefined : join(home, ".local", "bin"),
    home === "" ? undefined : join(home, ".npm-global", "bin"),
    home === "" ? undefined : join(home, ".bun", "bin"),
    home === "" ? undefined : join(home, ".cargo", "bin"),
    home === "" ? undefined : join(home, ".volta", "bin"),
    home === "" ? undefined : join(home, ".asdf", "shims"),
    home === "" ? undefined : join(home, ".local", "share", "mise", "shims"),
    home === "" ? undefined : join(home, ".local", "share", "pnpm"),
    home === "" ? undefined : join(home, "Library", "pnpm"),
    ...(home === ""
      ? []
      : versionBins(join(home, ".nvm", "versions", "node"), ["bin"])),
    ...(home === ""
      ? []
      : versionBins(join(home, ".local", "share", "fnm", "node-versions"), [
          "installation",
          "bin",
        ])),
    platform === "win32" ? env.APPDATA : undefined,
    platform === "darwin" ? "/opt/homebrew/bin" : undefined,
    platform === "darwin" ? "/usr/local/bin" : undefined,
    platform === "darwin" ? "/Applications/Codex.app/Contents/Resources" : undefined,
    platform === "darwin" ? "/Applications/Codex++.app/Contents/Resources" : undefined,
  ].filter((entry): entry is string => typeof entry === "string" && entry !== "");

  return [...new Set(candidates)].join(delimiter);
}

export function agentEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: agentSearchPath(env) };
}

export async function pathLookup(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const entries = agentSearchPath(env, platform).split(delimiter).filter((entry) => entry !== "");
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry !== "")
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
      if (!available) {
        return {
          id,
          name: adapter.name,
          available,
          auth: "unknown" as const,
          efforts: adapter.efforts,
        };
      }
      const result = await probe(adapter.binary, adapter.authArgs).catch(() => null);
      return {
        id,
        name: adapter.name,
        available,
        auth: result === null ? ("unknown" as const) : adapter.authVerdict(result),
        efforts: adapter.efforts,
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

  const wrapped = /^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+([\s\S]*)$/.exec(command);
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

/**
 * Cursor announces tool use in events of its own rather than inside the
 * assistant message, which is where reading it as Claude's shape went wrong:
 * every tool call read as nothing, so a Cursor run showed no activity at all
 * and, worse, never looked like it had edited anything.
 *
 * The wrapper holds one key naming the tool (`readToolCall`, `writeToolCall`),
 * so the name is taken from the key and only the two documented ones are
 * claimed outright. Anything else is named without guessing what it did,
 * which is why Cursor does not carry `activityVerified`.
 */
function cursorActivity(event: Record<string, unknown>, cwd: string): string | null {
  if (event.type !== "tool_call") return null;
  const wrapper = record(event.tool_call);
  if (wrapper === null) return null;

  const key = Object.keys(wrapper)[0];
  if (key === undefined) return null;
  const call = record(wrapper[key]);
  const args = record(call?.args);
  const tool = key.replace(/ToolCall$/, "");

  if (tool === "write") {
    const path = shownPath(args?.path, cwd);
    return path === null ? "using write" : `editing ${path}`;
  }
  if (tool === "read") {
    const path = shownPath(args?.path, cwd);
    return path === null ? "using read" : `reading ${path}`;
  }
  const command = shownCommand(args?.command);
  if (command !== null) return `running ${command}`;
  const path = shownPath(args?.path, cwd);
  return path === null ? `using ${tool}` : `using ${tool} on ${path}`;
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
  if (agent === "cursor") return cursorActivity(event, cwd);
  return null;
}

/**
 * The session id one JSONL line names, so a later request can resume the
 * conversation instead of paying the survey again. Only vendors whose CLIs
 * expose a resume surface report one; everyone else stays null and cold.
 */
export function sessionFrom(agent: AgentChoice, line: string): string | null {
  if (agent === "custom") return null;
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (event === null) return null;
  return KNOWN_AGENTS[agent].sessionFrom(event);
}

/**
 * The retry a vendor CLI is announcing, when it announces one.
 *
 * Claude Code emits `system`/`api_retry` per attempt while it backs off, and
 * that event is the only thing Leglas hears during the stall: nothing reaches
 * stderr, and no other stdout event fires, so a run against an overloaded
 * provider looks identical to a run that is thinking. Measured against a
 * local endpoint returning 529: ten attempts with delays climbing 0.6s, 1s,
 * 2s, 4.9s, 9.2s, 19s, 32.6s, 35.3s, which is where the ~200s wait comes
 * from before the CLI exits nonzero.
 *
 * Codex retries its own requests silently, so a Codex stall stays opaque and
 * this returns nothing for it. That is the vendor's surface, not a gap here.
 */
export function retryFrom(agent: AgentChoice, line: string): RetryNotice | null {
  if (agent !== "claude" && agent !== "cursor") return null;
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (event === null || event.type !== "system" || event.subtype !== "api_retry") return null;

  const attempt = typeof event.attempt === "number" ? event.attempt : 1;
  return {
    attempt,
    max: typeof event.max_retries === "number" ? event.max_retries : null,
    status: typeof event.error_status === "number" ? event.error_status : null,
    reason: typeof event.error === "string" && event.error !== "" ? event.error.toLowerCase() : null,
  };
}

function isAgentChoice(value: unknown): value is AgentChoice {
  return value === "custom" || (typeof value === "string" && Object.hasOwn(KNOWN_AGENTS, value));
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (AGENT_EFFORTS as readonly string[]).includes(value);
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
  const agent = isAgentChoice(config.agent) ? config.agent : null;
  const efforts = record(config.efforts);
  return {
    agent,
    effort:
      agent !== null && agent !== "custom" && isAgentEffort(efforts?.[agent])
        ? efforts[agent]
        : null,
    run: typeof config.run === "string" && config.run !== "" ? config.run : null,
  };
}

/** Save only the fields this choice owns, leaving the watch template and future fields intact. */
export async function saveAgentChoice(cwd: string, choice: AgentChoiceInput): Promise<void> {
  const config = await readWatchConfig(cwd);
  config.agent = choice.agent;
  if (choice.agent !== "custom" && choice.effort !== undefined) {
    const efforts = record(config.efforts) ?? {};
    if (choice.effort === null) delete efforts[choice.agent];
    else efforts[choice.agent] = choice.effort;
    if (Object.keys(efforts).length === 0) delete config.efforts;
    else config.efforts = efforts;
  }
  if (choice.run !== undefined) config.run = choice.run;

  const path = join(cwd, WATCH_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
