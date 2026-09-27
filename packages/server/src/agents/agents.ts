import { spawn } from "node:child_process";
import { constants, readdirSync, realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, normalize, relative } from "node:path";

import { WATCH_PATH } from "./agent-command.js";
import type { RetryNotice } from "./failure.js";

import {
  isNumber,
  isString,
  isJsonRecord,
  parseJson,
  type JsonValue,
  type JsonRecord,
} from "../json.js";

/**
 * Whether a CLI's saved login will carry a run. "ok" and "signed-out" are the
 * CLI's own answer; "unknown" is anything else (no status command, output we
 * don't understand, a timeout). Unknown never blocks anything, since a wrong
 * "signed out" would box a user out of an agent that works.
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
 * Network access lets Codex reach the dev server already running instead of
 * failing to boot a second one; workspace-write stays the filesystem boundary.
 * The model stays the user's, and effort is set only when they pick one in
 * Leglas.
 */
const CODEX_WORKSPACE_CONFIG = ["-c", "sandbox_workspace_write.network_access=true"] as const;

// `args` feeds the runner's JSONL parser and `terminalArgs` a terminal someone
// watches; keep the pair in step when a CLI changes. `authArgs` and
// `authVerdict` are per vendor because no two CLIs report a login the same way.
// `resumeArgs` and `sessionFrom` exist where a vendor can resume a session: a
// resumed turn skips the repo survey, measured at 25-40% of a run's wall-clock.
export const KNOWN_AGENTS = {
  claude: {
    name: "Claude",
    binary: "claude",
    efforts: AGENT_EFFORTS,
    args: (
      prompt: string,
      effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...effortFlag(effort),
    ],
    terminalArgs: (
      prompt: string,
      effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => ["-p", prompt, "--permission-mode", "acceptEdits", ...effortFlag(effort)],
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
    // acceptEdits covers files only, and non-interactive Claude has nobody to
    // approve a Bash call, so a command the prompt requires is refused every
    // time. This allows that command and nothing wider. Codex needs none:
    // workspace-write already lets it run commands.
    allowArgs: (commands: readonly string[]): string[] => [
      "--allowedTools",
      ...commands.map((command) => `Bash(${command} *)`),
    ],
    activityVerified: true,
    // Every stream-json event names its session.
    sessionFrom: (event: JsonRecord): string | null =>
      isString(event.session_id) && event.session_id !== "" ? event.session_id : null,
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
    // Without `--skip-git-repo-check`, codex-cli refuses to run in a project
    // that isn't a git repository, before it reaches a model: "Not inside a
    // trusted directory and --skip-git-repo-check was not specified". The
    // sandbox, `-s workspace-write`, still confines writes to the project, and
    // in a git repository the flag does nothing.
    args: (
      prompt: string,
      effort: AgentEffort | null = null,
      images: readonly string[] = [],
    ): string[] => [
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
    terminalArgs: (
      prompt: string,
      effort: AgentEffort | null = null,
      images: readonly string[] = [],
    ): string[] => [
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
    sessionFrom: (event: JsonRecord): string | null =>
      event.type === "thread.started" && isString(event.thread_id) ? event.thread_id : null,
    activityVerified: true,
    authArgs: ["login", "status"],
    // `codex login status` exits 0 when logged in and nonzero when not.
    authVerdict: (result: ProbeResult): AgentAuth => (result.code === 0 ? "ok" : "signed-out"),
  },
  cursor: {
    name: "Cursor",
    binary: "cursor-agent",
    efforts: [],
    // Without `--trust`, print mode stops at a "Workspace Trust Required"
    // prompt nothing can answer and exits 1 with no events, in any directory
    // not trusted by hand (cursor-agent 2026.09.02). The project is the one the
    // user pointed Leglas at, which is all the flag trusts, and the flag is the
    // only permission a run needs: with it, an edit and a shell command in the
    // same run both ran.
    args: (
      prompt: string,
      _effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => ["-p", prompt, "--output-format", "stream-json", "--trust"],
    terminalArgs: (
      prompt: string,
      _effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => ["-p", prompt, "--trust"],
    // `--resume [chatId]` is documented beside `--continue`, and every
    // stream-json event carries the `session_id` it takes. Cursor's process
    // still starts per request, but a resumed turn skips the repo survey, as it
    // does for Claude and Codex.
    //
    // Images are accepted and ignored, as in its other argument builders:
    // `cursor-agent` documents no flag for them, and the capture paths reach it
    // as text in the prompt.
    resumeArgs: (
      sessionId: string,
      prompt: string,
      _effort: AgentEffort | null = null,
      _images: readonly string[] = [],
    ): string[] => [
      "-p",
      "--resume",
      sessionId,
      prompt,
      "--output-format",
      "stream-json",
      "--trust",
    ],
    sessionFrom: (event: JsonRecord): string | null =>
      isString(event.session_id) && event.session_id !== "" ? event.session_id : null,
    // Read against cursor-agent 2026.09.02: every event carries the id, a
    // resume in this argument order answers under the same id and remembers
    // the earlier turn.
    activityVerified: true,
    authArgs: ["status"],
    // Both answers read from cursor-agent 2026.09.02, and both exit 0: "✓ Logged
    // in as <email>" and "Not logged in". The second contains the first's
    // words, so a "not logged in" or "not signed in" is read first.
    authVerdict: (result: ProbeResult): AgentAuth => {
      if (/not (logged|signed) in/i.test(result.stdout)) return "signed-out";

      if (/logged in|signed in/i.test(result.stdout)) return "ok";

      if (result.code !== 0 || /log in|sign in/i.test(result.stdout)) return "signed-out";

      return "unknown";
    },
  },
} as const;

export type KnownAgentId = keyof typeof KNOWN_AGENTS;

export type AgentChoice = KnownAgentId | "custom";

/**
 * Whether Leglas can tell from a vendor's output that it edited a file. Only
 * an adapter whose event shape was read against the real CLI may set the flag.
 * It gates the runner's one cold rerun after a dead session: rerunning a run
 * that edited can stack half-applied changes, so a vendor whose edits Leglas
 * can't see is never rerun on its own.
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

export type AuthProbe = (binary: string, args: readonly string[]) => Promise<ProbeResult | null>;

const PROBE_TIMEOUT_MS = 3000;

/**
 * One status command, capped stdout, hard deadline: a CLI that hangs on its
 * status question reads as unknown instead of holding the agents endpoint. The
 * deadline resolves as well as kills, because "close" waits for the output
 * streams and a wrapper whose child outlives it keeps the pipe open. Without
 * that, the endpoint's one in-flight probe would never settle, every later
 * request would wait on it, and the composer's chooser would stop loading for
 * the life of the server.
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
 * A detached Leglas server doesn't inherit what .zprofile, .bashrc or a
 * version manager add, so without these a CLI that works in the user's
 * terminal is missing from the picker and fails to spawn. The inherited PATH
 * stays first, followed only by conventional per-user and system bin
 * directories; detection and execution both use this environment.
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
    npmPrefix === undefined ? undefined : platform === "win32" ? npmPrefix : join(npmPrefix, "bin"),
    home === "" ? undefined : join(home, ".local", "bin"),
    home === "" ? undefined : join(home, ".npm-global", "bin"),
    home === "" ? undefined : join(home, ".bun", "bin"),
    home === "" ? undefined : join(home, ".cargo", "bin"),
    home === "" ? undefined : join(home, ".volta", "bin"),
    home === "" ? undefined : join(home, ".asdf", "shims"),
    home === "" ? undefined : join(home, ".local", "share", "mise", "shims"),
    home === "" ? undefined : join(home, ".local", "share", "pnpm"),
    home === "" ? undefined : join(home, "Library", "pnpm"),
    ...(home === "" ? [] : versionBins(join(home, ".nvm", "versions", "node"), ["bin"])),
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
  ].filter((entry): entry is string => isString(entry) && entry !== "");

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
  const entries = agentSearchPath(env, platform)
    .split(delimiter)
    .filter((entry) => entry !== "");

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
 * Every built-in adapter: whether its binary can run and whether its login is
 * live. Probes run in parallel, so a call costs the slowest status command,
 * about a second, and callers cache the answer instead of paying it per
 * request.
 */
export async function detectAgents(
  lookup: BinaryLookup = pathLookup,
  probe: AuthProbe = execProbe,
): Promise<DetectedAgent[]> {
  // SAFETY: `KNOWN_AGENTS` is the closed adapter literal declared in this module.
  const entries = Object.entries(KNOWN_AGENTS) as [
    KnownAgentId,
    (typeof KNOWN_AGENTS)[KnownAgentId],
  ][];

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

function record(value: JsonValue | undefined): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

function shownPath(value: JsonValue | undefined, cwd: string): string | null {
  if (!isString(value) || value === "") return null;

  if (!isAbsolute(value)) return value;

  return relative(cwd, value) || ".";
}

/**
 * The command itself for a status line: the shell wrapper agents put around
 * everything is dropped, and the first 48 characters of its first line say
 * enough ("npm test", "grep -r Hero src").
 */
function shownCommand(value: JsonValue | undefined): string | null {
  let command = Array.isArray(value)
    ? value.filter((part) => isString(part)).join(" ")
    : isString(value)
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

function claudeActivity(event: JsonRecord, cwd: string): string | null {
  if (event.type !== "assistant") return null;
  const message = record(event.message);

  if (message === null || !Array.isArray(message.content)) return null;

  for (const rawBlock of message.content) {
    const block = record(rawBlock);

    if (block?.type !== "tool_use" || !isString(block.name)) continue;

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

function codexActivity(event: JsonRecord, cwd: string): string | null {
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
 * Cursor reports tool use in `tool_call` events of its own, not inside the
 * assistant message as Claude does. Read against cursor-agent 2026.09.02 rather
 * than its docs: the tool is whichever key ends in `ToolCall` (it sits beside
 * `toolCallId`, `startedAtMs` and `hookAdditionalContexts`), a file change is
 * `editToolCall` with `args.path` (the documented `writeToolCall` is kept in
 * case a version sends it), and `readToolCall` and `shellToolCall` carry
 * `args.path` and `args.command`. Anything else is named without guessing what
 * it did.
 */
function cursorActivity(event: JsonRecord, cwd: string): string | null {
  if (event.type !== "tool_call") return null;
  const wrapper = record(event.tool_call);

  if (wrapper === null) return null;

  const key = Object.keys(wrapper).find((name) => name.endsWith("ToolCall"));

  if (key === undefined) return null;
  const call = record(wrapper[key]);
  const args = record(call?.args);
  const tool = key.replace(/ToolCall$/, "");

  if (tool === "edit" || tool === "write") {
    // Still "editing" when the path didn't resolve: the runner reads that word
    // to know a run touched a file, and anything else would let a run that
    // edited be rerun on top of its own change.
    const path = shownPath(args?.path, cwd);

    return path === null ? "editing a file" : `editing ${path}`;
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

/** Every file a stream line says was edited, relative to `cwd`. Codex shell-command writes don't show up. */
export function editedFiles(agent: AgentChoice, line: string, cwd: string): string[] {
  let event: JsonRecord | null;

  try {
    event = record(parseJson(line));
  } catch {
    return [];
  }

  const paths: JsonValue[] = [];

  if (agent === "claude" && event?.type === "assistant") {
    const content = record(event.message)?.content;

    for (const rawBlock of Array.isArray(content) ? content : []) {
      const block = record(rawBlock);
      const input = record(block?.input);

      if (
        block?.type === "tool_use" &&
        isString(block.name) &&
        ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name)
      )
        paths.push(input?.file_path ?? input?.notebook_path ?? null);
    }
  }

  if (
    agent === "codex" &&
    (event?.type === "item.started" || event?.type === "item.completed") &&
    record(event.item)?.type === "file_change"
  ) {
    const item = record(event.item);

    for (const change of Array.isArray(item?.changes) ? item.changes : [])
      paths.push(record(change)?.path ?? null);
    paths.push(item?.path ?? null);
  }

  if (paths.length === 0) return [];

  // The agent may report either side of a symlinked root.
  let root = cwd;

  try {
    root = realpathSync(cwd);
  } catch {
    // Compared as given.
  }

  return paths.flatMap((path) => {
    if (!isString(path) || path === "") return [];

    if (!isAbsolute(path)) return [normalize(path)];

    // Outside both roots: keep the absolute path.
    const shown = [relative(cwd, path), relative(root, path)].find(
      (form) => !form.startsWith(".."),
    );

    return [normalize(shown ?? path)];
  });
}

/** Reduce one agent JSONL event to a short, user-facing activity label. */
export function activityFrom(agent: AgentChoice, line: string, cwd = process.cwd()): string | null {
  let event: JsonRecord | null;

  try {
    event = record(parseJson(line));
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
 * The session id a JSONL line names, so a later request can resume the
 * conversation instead of surveying again. Only vendors with a resume surface
 * report one; the rest stay null.
 */
export function sessionFrom(agent: AgentChoice, line: string): string | null {
  if (agent === "custom") return null;
  let event: JsonRecord | null;

  try {
    event = record(parseJson(line));
  } catch {
    return null;
  }

  if (event === null) return null;

  return KNOWN_AGENTS[agent].sessionFrom(event);
}

/**
 * The retry a vendor CLI is announcing, if it announces one.
 *
 * Claude Code emits `system`/`api_retry` per attempt while it backs off, and
 * nothing else reaches Leglas during the stall, so without it a run against an
 * overloaded provider looks like one that is thinking. Against a local
 * endpoint answering 529 that was ten attempts over about 200 s, then a
 * nonzero exit. Cursor's lines are read the same way. Codex retries its own
 * requests silently, so a Codex stall stays opaque.
 */
export function retryFrom(agent: AgentChoice, line: string): RetryNotice | null {
  if (agent !== "claude" && agent !== "cursor") return null;
  let event: JsonRecord | null;

  try {
    event = record(parseJson(line));
  } catch {
    return null;
  }

  if (event === null || event.type !== "system" || event.subtype !== "api_retry") return null;

  const attempt = isNumber(event.attempt) ? event.attempt : 1;

  return {
    attempt,
    max: isNumber(event.max_retries) ? event.max_retries : null,
    status: isNumber(event.error_status) ? event.error_status : null,
    reason: isString(event.error) && event.error !== "" ? event.error.toLowerCase() : null,
  };
}

function isAgentChoice(value: unknown): value is AgentChoice {
  return value === "custom" || (isString(value) && Object.hasOwn(KNOWN_AGENTS, value));
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return isString(value) && AGENT_EFFORTS.some((effort) => effort === value);
}

async function readWatchConfig(cwd: string): Promise<JsonRecord> {
  try {
    const parsed = parseJson(await readFile(join(cwd, WATCH_PATH), "utf8"));

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
    run: isString(config.run) && config.run !== "" ? config.run : null,
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
