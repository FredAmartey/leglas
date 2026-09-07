import { spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

import { DEFAULT_PORT } from "./server.js";

export type InstallKind = "npx" | "global" | "project" | "source";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Install = {
  kind: InstallKind;
  manager: PackageManager;
  /** The command a person can run to update, or null for a checkout. */
  command: string | null;
  /** The directory a project command runs in. Project kind only. */
  root?: string;
};

export type Release = {
  version: string;
  /** The changelog heading's title, when the site answered. */
  title: string | null;
  url: string;
};

export type UpdatePhase =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "installing"; version: string }
  | { status: "waiting"; version: string }
  | { status: "restarting"; version: string }
  | { status: "failed"; version: string; reason: string };

export type UpdateStatus = {
  /** The version running now. */
  version: string;
  install: Install;
  /** The newest release from the cache or the last successful check. */
  latest: Release | null;
  checkedAt: string | null;
  checkError: string | null;
  skipped: string | null;
  /** Whether latest is newer than version, regardless of the skip. */
  available: boolean;
  phase: UpdatePhase;
  /** Whether installing would interrupt a change in the embedded agent. */
  busy: boolean;
};

/** What the CLI spawns, including the bound port and --no-open. */
export type RestartCommand = { file: string; args: string[]; shell: boolean };

export type UpdateService = {
  status(): UpdateStatus;
  /** Ask npm, reusing a cache under a day old unless forced. Never rejects. */
  check(options?: { force?: boolean }): Promise<UpdateStatus>;
  /** Remember the newest known version as skipped. Rejects for any other version. */
  skip(version: string): Promise<UpdateStatus>;
  /** Begin an install, resolving at installing while the handoff runs in the background. */
  update(): Promise<UpdateStatus>;
  notice(): string | null;
  onRestart(restart: (command: RestartCommand) => Promise<void>): void;
  onBusy(busy: () => boolean): void;
  setPort(port: number): void;
  onChange(listener: () => void): void;
  /** Stop a running installer before the server releases its other resources. */
  close(): Promise<void>;
};

export type UpdateDeps = {
  fetch?: typeof fetch;
  spawn?: typeof spawnChild;
  now?: () => number;
  /** Defaults to ~/.leglas/update.json. Tests keep all state in a temporary directory. */
  statePath?: string | null;
  homedir?: () => string;
  /** Registry and site deadline, in milliseconds. Defaults to 4000. */
  timeoutMs?: number;
  /** Project lockfile discovery, injectable so tests need no installed package. */
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string | null;
  /** POSIX installers own a process group so their children stop with them. */
  kill?: typeof process.kill;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  /** One terminal line before an install and before a restart. Defaults to console.log. */
  log?: (line: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const INSTALL_DEADLINE_MS = 5 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org";
const RELEASES = "https://leglas.vercel.app/releases.json";
const CHECKOUT_NOTICE = "You run Leglas from a checkout, so pull to update.";
const releaseUrl = (version: string): string => `https://leglas.vercel.app/changelog/#v${version}`;

function normalized(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const COMMANDS = {
  npx: { npm: ["npx"], pnpm: ["pnpm", "dlx"], bun: ["bunx"], yarn: ["yarn", "dlx"] },
  global: { npm: ["npm", "i", "-g"], pnpm: ["pnpm", "add", "-g"], bun: ["bun", "add", "-g"], yarn: ["yarn", "global", "add"] },
  project: { npm: ["npm", "install"], pnpm: ["pnpm", "up"], bun: ["bun", "update"], yarn: ["yarn", "up"] },
} as const;
const YARN_CLASSIC = ["yarn", "upgrade"];

function commandParts(kind: Exclude<InstallKind, "source">, manager: PackageManager, version: string, classic = false): string[] {
  return [...(classic ? YARN_CLASSIC : COMMANDS[kind][manager]), `leglas@${version}`];
}

function installation(kind: Exclude<InstallKind, "source">, manager: PackageManager, root?: string, classic = false): Install {
  return { kind, manager, command: commandParts(kind, manager, "latest", classic).join(" "), ...(root === undefined ? {} : { root }) };
}

function* ancestors(directory: string): Generator<string> {
  const paths = /^[a-z]:\//i.test(directory) ? win32 : posix;
  let current = directory;
  while (true) {
    yield current;
    const parent = normalized(paths.dirname(current));
    if (parent === current) return;
    current = parent;
  }
}

function environmentManager(env: NodeJS.ProcessEnv): PackageManager | null {
  const manager = /^(npm|pnpm|bun|yarn)\//.exec(env.npm_config_user_agent ?? "")?.[1];
  return manager === "pnpm" || manager === "bun" || manager === "yarn" || manager === "npm" ? manager : null;
}

function projectInstall(root: string, exists: (path: string) => boolean): Install {
  for (const directory of ancestors(root)) {
    if (exists(posix.join(directory, "pnpm-lock.yaml"))) return installation("project", "pnpm", root);
    if (exists(posix.join(directory, "yarn.lock"))) {
      return installation("project", "yarn", root, !exists(posix.join(directory, ".yarnrc.yml")));
    }
    if (exists(posix.join(directory, "bun.lock")) || exists(posix.join(directory, "bun.lockb"))) return installation("project", "bun", root);
    if (exists(posix.join(directory, "package-lock.json")) || exists(posix.join(directory, "npm-shrinkwrap.json"))) return installation("project", "npm", root);
  }
  return installation("project", "npm", root);
}

export function detectInstall(
  entry: string,
  cwd: string,
  exists: (path: string) => boolean,
  realpath: (path: string) => string | null = realPath,
  env: NodeJS.ProcessEnv = process.env,
): Install {
  const path = normalized(entry);
  const directory = normalized(realpath(cwd) ?? cwd);
  const manager = environmentManager(env);
  if (path.includes("/_npx/")) return installation("npx", "npm");
  if (path.includes("/pnpm/") && path.includes("/dlx/")) return installation("npx", "pnpm");
  if (/\/bunx-[^/]+\//.test(path)) return installation("npx", "bun");
  if (/\/dlx-[^/]+\//.test(path)) return installation("npx", "yarn");
  const berry = /\/\.yarn\/(?:berry\/)?cache\//.test(path) || path.includes("/.yarn/unplugged/");
  const packageIndex = path.lastIndexOf("/node_modules/leglas/");
  const cached = /\/(?:tmp|temp|cache|\.cache)\//i.test(path) || path.includes("/Library/Caches/") ||
    /\/var\/folders\/[^/]+\/[^/]+\/T\//.test(path) ||
    [env.TMPDIR, env.TEMP, env.TMP].some((temp) => temp !== undefined && path.startsWith(`${normalized(temp).replace(/\/$/, "")}/`));
  if (!berry && packageIndex !== -1 && cached && manager !== null && manager !== "npm") {
    return installation("npx", manager);
  }

  if (berry) {
    for (const root of ancestors(directory)) {
      if (exists(posix.join(root, "yarn.lock")) && exists(posix.join(root, ".yarnrc.yml"))) return installation("project", "yarn", root);
    }
    // Berry removed global add. Without its project we cannot offer an install.
    return { kind: "source", manager: "yarn", command: null };
  }
  if (packageIndex === -1) return { kind: "source", manager: "npm", command: null };

  const packageDirectory = path.slice(0, packageIndex + "/node_modules/leglas".length);
  const windows = /^[a-z]:\//i.test(path) || entry.startsWith("\\\\");
  const comparable = (value: string): string => windows ? normalized(value).toLowerCase() : normalized(value);
  for (const root of ancestors(directory)) {
    const dependency = realpath(posix.join(root, "node_modules/leglas"));
    if (dependency !== null && comparable(dependency) === comparable(packageDirectory)) return projectInstall(root, exists);
  }

  // pnpm can resolve a dlx cache entry into its links store. A dependency
  // linked from the current project was accounted for before this fallback.
  if (path.includes("/pnpm/") && /\/store\/[^/]+\/links\//.test(path) && manager === "pnpm") return installation("npx", "pnpm");
  if (path.includes("/pnpm/")) return installation("global", "pnpm");
  if (path.includes("/yarn/global/") || path.includes("/.yarn/global/")) return installation("global", "yarn");
  if (path.includes("/.bun/")) return installation("global", "bun");
  return installation("global", manager ?? "npm");
}

function parsedVersion(value: string): { core: bigint[]; pre: string[] } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (match === null) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map((part) => BigInt(part!)), pre };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parsedVersion(a);
  const right = parsedVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i]! < right.core[i]!) return -1;
    if (left.core[i]! > right.core[i]!) return 1;
  }
  if (left.pre.length === 0) return right.pre.length === 0 ? 0 : 1;
  if (right.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function windowsLine(parts: readonly string[]): string {
  return parts.map((part) => {
    if (part !== "" && !/[\s"&|<>^()]/.test(part)) return part;
    return `"${part.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  }).join(" ");
}

function spawnCommand(parts: readonly string[], platform: NodeJS.Platform): RestartCommand {
  if (platform === "win32") return { file: windowsLine(parts), args: [], shell: true };
  return { file: parts[0]!, args: parts.slice(1), shell: false };
}

export function restartCommand(
  install: Install,
  argv: readonly string[],
  latest: string,
  port: number,
  options: { execPath: string; platform: NodeJS.Platform; exists: (path: string) => boolean },
): RestartCommand {
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === "--port") i += 1;
    else if (!argument.startsWith("--port=") && argument !== "--no-open") rest.push(argument);
  }
  rest.push("--port", String(port), "--no-open");
  const windows = options.platform === "win32";
  if (install.kind === "npx") {
    const runner = [...COMMANDS.npx[install.manager], ...(install.manager === "npm" ? ["-y"] : []), `leglas@${latest}`];
    return spawnCommand([...runner, ...rest], options.platform);
  }
  if (install.kind === "global") {
    if (argv[1] !== undefined && options.exists(argv[1])) return { file: options.execPath, args: [argv[1], ...rest], shell: false };
    return spawnCommand(["leglas", ...rest], options.platform);
  }
  if (install.kind === "project" && install.root !== undefined) {
    const shim = (windows ? win32.join : join)(install.root, "node_modules", ".bin", windows ? "leglas.cmd" : "leglas");
    return spawnCommand(options.exists(shim) ? [shim, ...rest] : ["yarn", "leglas", ...rest], options.platform);
  }
  throw new Error(CHECKOUT_NOTICE);
}

type SavedUpdate = { checkedAt: string | null; latest: Release | null; skipped: string | null };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(path: string | null): SavedUpdate {
  const empty: SavedUpdate = { checkedAt: null, latest: null, skipped: null };
  if (path === null) return empty;
  try {
    // status() is synchronous, so its first caller should already see the cache.
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(value)) return empty;
    if (value.checkedAt !== null && (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))) return empty;
    if (value.skipped !== null && (typeof value.skipped !== "string" || parsedVersion(value.skipped) === null)) return empty;
    let latest: Release | null = null;
    if (value.latest !== null) {
      const release = value.latest;
      if (!object(release) || typeof release.version !== "string" || parsedVersion(release.version) === null ||
          (release.title !== null && typeof release.title !== "string") || typeof release.url !== "string") return empty;
      latest = { version: release.version, title: release.title, url: releaseUrl(release.version) };
    }
    return { checkedAt: value.checkedAt, latest, skipped: value.skipped };
  } catch {
    return empty;
  }
}

function defaultStatePath(home: () => string): string | null {
  try {
    return join(home(), ".leglas", "update.json");
  } catch {
    return null;
  }
}

function mergeState(current: SavedUpdate, saved: SavedUpdate): SavedUpdate {
  const checked = (state: SavedUpdate): number => state.checkedAt === null ? -Infinity : Date.parse(state.checkedAt);
  const newest = checked(saved) > checked(current) ? saved : current;
  let skipped = current.skipped;
  if (saved.skipped !== null && (skipped === null || compareVersions(saved.skipped, skipped) > 0)) skipped = saved.skipped;
  if (skipped !== null && newest.latest !== null && compareVersions(newest.latest.version, skipped) > 0) skipped = null;
  return { latest: newest.latest, checkedAt: newest.checkedAt, skipped };
}

async function writeState(path: string, state: SavedUpdate): Promise<void> {
  let temporary: string | null = null;
  try {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) return;
    const existing = await lstat(path).catch(() => null);
    if (existing !== null && !existing.isFile()) return;
    // Several servers can remember an update at once. Each owns its temporary.
    temporary = await mkdtemp(join(directory, ".update-"));
    const file = join(temporary, "update.json");
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(file, path);
  } catch {
    // A check still worked when the disk could not remember it.
  } finally {
    if (temporary !== null) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function registryVersion(fetcher: typeof fetch, timeoutMs: number, registry: string): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${registry}/leglas/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(timedOut(error) ? "npm took too long to answer." : "Could not reach npm.");
  }
  if (response.status !== 200) throw new Error(`npm answered ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(timedOut(error) ? "npm took too long to answer." : "npm's answer made no sense.");
  }
  if (!object(body) || typeof body.version !== "string" || parsedVersion(body.version) === null) {
    throw new Error("npm's answer made no sense.");
  }
  return body.version;
}

async function releaseTitles(fetcher: typeof fetch, timeoutMs: number): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const response = await fetcher(RELEASES, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) return titles;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return titles;
    for (const entry of body) {
      if (object(entry) && typeof entry.version === "string" && typeof entry.title === "string") {
        titles.set(entry.version, entry.title);
      }
    }
  } catch {
    // The version from npm is useful even when the changelog site is down.
  }
  return titles;
}

export function installerReason(stdout: string, stderr: string): string | null {
  const lines = (output: string): string[] => output.split(/\r?\n/)
    .filter((line) => !/^\s+at /.test(line) && !/A complete log of this run|info Visit https:\/\/yarnpkg\.com/.test(line))
    .map((line) => line.trim()).filter(Boolean);
  const errors = lines(stderr);
  const output = lines(stdout);
  const npm = [...errors, ...output].find((line) => /^npm error\s+\S/.test(line) && !/^npm error code\s/.test(line));
  return npm?.replace(/^npm error\s+/, "") ?? errors[0] ?? output[0] ?? null;
}

type RunningInstaller = {
  result: Promise<void>;
  gone: Promise<void>;
  stop(): void;
};

function installVersion(
  install: Install,
  version: string,
  deps: { spawn: typeof spawnChild; kill: typeof process.kill; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; log: (line: string) => void },
): RunningInstaller {
  if (install.kind !== "global" && install.kind !== "project") throw new Error(CHECKOUT_NOTICE);
  // Install keeps its public shape. Its displayed command distinguishes the
  // two Yarn project dialects without parsing a shell command into arguments.
  const classic = install.command === commandParts("project", "yarn", "latest", true).join(" ");
  const parts = commandParts(install.kind, install.manager, version, classic);
  const command = parts.join(" ");
  const invocation = spawnCommand(parts, deps.platform);
  deps.log(`Updating Leglas to ${version} with ${command}…`);
  const child = deps.spawn(invocation.file, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: invocation.shell,
    detached: deps.platform !== "win32",
    env: deps.env,
    ...(install.kind === "project" ? { cwd: install.root } : {}),
  });
  let settle!: () => void;
  let reject!: (error: Error) => void;
  const result = new Promise<void>((resolve, fail) => { settle = resolve; reject = fail; });
  let markGone!: () => void;
  const gone = new Promise<void>((resolve) => { markGone = resolve; });
  let settled = false;
  let exited = false;
  let stopping = false;
  let stdout = "";
  let stderr = "";
  const readOut = (chunk: Buffer | string): void => { stdout = (stdout + chunk.toString()).slice(-64_000); };
  const readErr = (chunk: Buffer | string): void => { stderr = (stderr + chunk.toString()).slice(-64_000); };
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error === undefined) settle();
    else reject(error);
  };
  const stop = (): void => {
    if (stopping || exited) return;
    stopping = true;
    try {
      if (child.pid === undefined) child.kill("SIGKILL");
      else if (deps.platform === "win32") {
        // taskkill reaches the manager's descendants, including lifecycle scripts.
        const killer = deps.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false });
        killer.once("error", () => child.kill("SIGKILL"));
      } else deps.kill(-child.pid, "SIGKILL");
    } catch {
      // The process may have exited just before its close event is delivered.
    }
  };
  const timer = setTimeout(() => {
    finish(new Error(`${command} took longer than five minutes.`));
    stop();
  }, INSTALL_DEADLINE_MS);
  timer.unref?.();
  child.stdout?.on("data", readOut);
  child.stderr?.on("data", readErr);
  const onGone = (): void => {
    exited = true;
    clearTimeout(timer);
    child.stdout?.off("data", readOut);
    child.stderr?.off("data", readErr);
    markGone();
  };
  child.once("error", (error: Error) => {
    finish(error);
    if (child.pid === undefined) onGone();
  });
  // close follows the final stdout/stderr bytes, unlike exit. pnpm's reason
  // arrives on stdout, so both streams must have drained before reporting it.
  child.once("close", (code: number | null) => {
    const reason = installerReason(stdout, stderr);
    finish(code === 0 ? undefined : new Error(`${command} exited ${code ?? 1}.${reason === null ? "" : ` ${reason}`}`));
    onGone();
  });
  return { result, gone, stop };
}

export function createUpdateService(input: {
  version: string;
  /** Real path of the running bin.js, with symlinks resolved. */
  entry: string;
  argv: readonly string[];
  cwd: string;
  deps?: UpdateDeps;
}): UpdateService {
  const deps = input.deps ?? {};
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 4000;
  const statePath = deps.statePath === undefined ? defaultStatePath(deps.homedir ?? homedir) : deps.statePath;
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  const install = detectInstall(input.entry, input.cwd, exists, deps.realpath ?? realPath, env);
  const spawn = deps.spawn ?? spawnChild;
  const kill = deps.kill ?? process.kill.bind(process);
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const log = deps.log ?? console.log;
  // Registry selection belongs here; proxy handling stays the runtime's business.
  const registry = (env.npm_config_registry || REGISTRY).replace(/\/+$/, "");
  const argv = [...input.argv];
  let state: SavedUpdate & { checkError: string | null; phase: UpdatePhase } = {
    ...readState(statePath), checkError: null, phase: { status: "idle" },
  };
  let checking: Promise<UpdateStatus> | null = null;
  let writing = Promise.resolve();
  let port = DEFAULT_PORT;
  let busy = (): boolean => false;
  let restart: ((command: RestartCommand) => Promise<void>) | null = null;
  let installer: RunningInstaller | null = null;
  let pending: ReturnType<typeof setImmediate> | null = null;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let resume: (() => void) | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const change = (next: Partial<typeof state>): void => {
    if (Object.entries(next).every(([key, value]) => JSON.stringify(state[key as keyof typeof state]) === JSON.stringify(value))) return;
    state = { ...state, ...next };
    for (const listener of listeners) {
      try { listener(); } catch {
        // An observer cannot turn a successful check or install into a failure.
      }
    }
  };
  const available = (): boolean => state.latest !== null && compareVersions(state.latest.version, input.version) > 0;
  const inFlight = (): boolean => ["installing", "waiting", "restarting"].includes(state.phase.status) || installer !== null;
  const status = (): UpdateStatus => ({
    version: input.version,
    install: { ...install },
    latest: state.latest === null ? null : { ...state.latest },
    checkedAt: state.checkedAt,
    checkError: state.checkError,
    skipped: state.skipped,
    available: available(),
    phase: { ...state.phase },
    busy: busy(),
  });
  const persist = (): Promise<void> => {
    if (statePath === null) return Promise.resolve();
    writing = writing.then(async () => {
      // Another Leglas may have checked or skipped since this one started.
      const merged = mergeState(state, readState(statePath));
      change(merged);
      await writeState(statePath, merged);
    });
    return writing;
  };
  const waitForIdle = async (version: string): Promise<void> => {
    if (!busy() || closed) return;
    change({ phase: { status: "waiting", version } });
    while (!closed && busy()) {
      await new Promise<void>((resolve) => {
        resume = resolve;
        waiting = setTimeout(() => {
          waiting = null;
          resume = null;
          resolve();
        }, 1000);
        waiting.unref?.();
      });
    }
  };
  const performUpdate = async (version: string, handoff: (command: RestartCommand) => Promise<void>): Promise<void> => {
    try {
      if (closed) return;
      if (install.kind !== "npx") {
        const running = installVersion(install, version, { spawn, kill, platform, env, log });
        installer = running;
        void running.gone.then(() => { if (installer === running) installer = null; });
        await running.result;
      }
      await waitForIdle(version);
      if (closed) return;
      change({ phase: { status: "restarting", version } });
      log(`Restarting Leglas with ${version}…`);
      await handoff(restartCommand(install, argv, version, port, { execPath, platform, exists }));
    } catch (error) {
      if (!closed) change({ phase: { status: "failed", version, reason: error instanceof Error ? error.message : String(error) } });
    }
  };

  return {
    status,
    check(options = {}): Promise<UpdateStatus> {
      if (closed) return Promise.resolve(status());
      if (checking !== null) return checking;
      if (!options.force && state.latest !== null && state.checkedAt !== null) {
        const age = now() - Date.parse(state.checkedAt);
        if (age >= 0 && age < DAY_MS) return Promise.resolve(status());
      }
      // A concurrent check must not hide an install and allow a second one.
      if (!inFlight()) change({ phase: { status: "checking" } });
      checking = (async () => {
        try {
          const [version, titles] = await Promise.all([
            registryVersion(fetcher, timeoutMs, registry),
            releaseTitles(fetcher, timeoutMs),
          ]);
          if (!closed) {
            change({
              latest: { version, title: titles.get(version) ?? null, url: releaseUrl(version) },
              checkedAt: new Date(now()).toISOString(),
              checkError: null,
              skipped: state.skipped !== null && compareVersions(version, state.skipped) > 0 ? null : state.skipped,
            });
            await persist();
          }
        } catch (error) {
          if (!closed) change({ checkError: error instanceof Error ? error.message : "Could not reach npm." });
        } finally {
          if (state.phase.status === "checking") change({ phase: { status: "idle" } });
          checking = null;
        }
        return status();
      })();
      return checking;
    },
    async skip(version): Promise<UpdateStatus> {
      if (state.latest?.version !== version) throw new Error("That is not the newest version.");
      change({ skipped: version });
      await persist();
      return status();
    },
    async update(): Promise<UpdateStatus> {
      if (closed) throw new Error("Updates are not available here.");
      if (inFlight()) throw new Error("An update is already running.");
      if (!available()) throw new Error("You have the newest version.");
      if (install.kind === "source") throw new Error(CHECKOUT_NOTICE);
      if (busy()) throw new Error("A change is running. Wait for it to finish.");
      if (restart === null) throw new Error("Updates are not available here.");
      const version = state.latest!.version;
      const handoff = restart;
      change({ phase: { status: "installing", version } });
      // The route must answer before a fast runner handoff can close its socket.
      pending = setImmediate(() => {
        pending = null;
        void performUpdate(version, handoff);
      });
      return status();
    },
    notice(): string | null {
      const { latest, skipped } = state;
      if (!available() || latest === null || latest.version === skipped) return null;
      const title = latest.title === null ? "" : `: ${latest.title}`;
      const next = install.kind === "source"
        ? CHECKOUT_NOTICE
        : install.kind === "npx"
          ? `Update from the interface, or start Leglas again with ${install.command}`
          : `Update from the interface, or run ${install.command}`;
      return `update   ${latest.version} is out, you have ${input.version}${title}\n         ${next}`;
    },
    onRestart(handler): void { restart = handler; },
    onBusy(handler): void { busy = handler; },
    setPort(value): void { port = value; },
    onChange(listener): void { listeners.add(listener); },
    close(): Promise<void> {
      if (closing !== null) return closing;
      closed = true;
      if (pending !== null) clearImmediate(pending);
      if (waiting !== null) clearTimeout(waiting);
      resume?.();
      listeners.clear();
      installer?.stop();
      // Do not await the handoff here: the handoff itself closes this server.
      closing = installer?.gone ?? Promise.resolve();
      return closing;
    },
  };
}
