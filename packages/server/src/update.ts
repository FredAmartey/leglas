import { spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

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
};

export type UpdateDeps = {
  fetch?: typeof fetch;
  spawn?: typeof spawnChild;
  now?: () => number;
  /** Defaults to ~/.leglas/update.json. Tests keep all state in a temporary directory. */
  statePath?: string;
  /** Registry and site deadline, in milliseconds. Defaults to 4000. */
  timeoutMs?: number;
  /** Project lockfile discovery, injectable so tests need no installed package. */
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  /** One terminal line before an install and before a restart. Defaults to console.log. */
  log?: (line: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const INSTALL_DEADLINE_MS = 5 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/leglas/latest";
const RELEASES = "https://leglas.vercel.app/releases.json";
const CHECKOUT_NOTICE = "You run Leglas from a checkout, so pull to update.";
const releaseUrl = (version: string): string => `https://leglas.vercel.app/changelog/#v${version}`;

function normalized(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}

function projectDirectory(cwd: string): string {
  // A shell can enter the project through a symlink while bin.js is already real.
  try {
    return normalized(realpathSync(cwd));
  } catch {
    return normalized(cwd);
  }
}

export function detectInstall(entry: string, cwd: string, exists: (path: string) => boolean): Install {
  const path = normalized(entry);
  if (path.includes("/_npx/")) return { kind: "npx", manager: "npm", command: "npx leglas@latest" };

  if (!path.includes("/node_modules/leglas/")) return { kind: "source", manager: "npm", command: null };

  // The first node_modules on the path is the one that belongs to a project.
  // pnpm resolves a dependency's real path through node_modules/.pnpm/<name>@
  // <version>/node_modules/<name>, so the last one is inside the store and
  // names no project at all.
  const index = path.indexOf("/node_modules/");
  const root = path.slice(0, index) || "/";
  const directory = projectDirectory(cwd);
  const windows = /^[a-z]:\//i.test(path) || entry.startsWith("\\\\");
  const parent = windows ? root.toLowerCase() : root;
  const current = windows ? directory.toLowerCase() : directory;
  if (current === parent || current.startsWith(`${parent.replace(/\/$/, "")}/`)) {
    if (exists(`${root}/pnpm-lock.yaml`)) {
      return { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root };
    }
    if (exists(`${root}/yarn.lock`)) {
      const action = exists(`${root}/.yarnrc.yml`) ? "up" : "upgrade";
      return { kind: "project", manager: "yarn", command: `yarn ${action} leglas@latest`, root };
    }
    if (exists(`${root}/bun.lock`) || exists(`${root}/bun.lockb`)) {
      return { kind: "project", manager: "bun", command: "bun update leglas@latest", root };
    }
    return { kind: "project", manager: "npm", command: "npm install leglas@latest", root };
  }

  if (path.includes("/pnpm/")) return { kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" };
  if (path.includes("/.yarn/") || path.includes("/yarn/global/")) {
    return { kind: "global", manager: "yarn", command: "yarn global add leglas@latest" };
  }
  if (path.includes("/.bun/")) return { kind: "global", manager: "bun", command: "bun add -g leglas@latest" };
  return { kind: "global", manager: "npm", command: "npm i -g leglas@latest" };
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

export function restartCommand(
  install: Install,
  argv: readonly string[],
  latest: string,
  port: number,
  options: { execPath: string; platform: NodeJS.Platform },
): RestartCommand {
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === "--port") i += 1;
    else if (!argument.startsWith("--port=") && argument !== "--no-open") rest.push(argument);
  }
  rest.push("--port", String(port), "--no-open");
  const windows = options.platform === "win32";
  if (install.kind === "npx") return { file: "npx", args: ["-y", `leglas@${latest}`, ...rest], shell: windows };
  if (install.kind === "global") return { file: options.execPath, args: [argv[1]!, ...rest], shell: false };
  if (install.kind === "project" && install.root !== undefined) {
    return {
      file: (windows ? win32.join : join)(install.root, "node_modules", ".bin", windows ? "leglas.cmd" : "leglas"),
      args: rest,
      shell: windows,
    };
  }
  throw new Error(CHECKOUT_NOTICE);
}

type SavedUpdate = { checkedAt: string | null; latest: Release | null; skipped: string | null };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(path: string): SavedUpdate {
  const empty: SavedUpdate = { checkedAt: null, latest: null, skipped: null };
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

async function registryVersion(fetcher: typeof fetch, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(REGISTRY, {
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

function installVersion(
  install: Install,
  version: string,
  deps: { spawn: typeof spawnChild; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; log: (line: string) => void },
): Promise<void> {
  const args = install.command!.split(" ").slice(1).map((arg) => arg.replace("@latest", `@${version}`));
  const command = [install.manager, ...args].join(" ");
  deps.log(`Updating Leglas to ${version} with ${command}…`);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnChild>;
    try {
      // Nothing an installer prints belongs under the startup block, but its
      // last line of stderr is the one useful thing a failure can quote.
      child = deps.spawn(install.manager, args, {
        stdio: ["ignore", "ignore", "pipe"],
        shell: deps.platform === "win32",
        env: deps.env,
        ...(install.kind === "project" ? { cwd: install.root } : {}),
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let stderr = "";
    const read = (chunk: Buffer | string): void => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.off("data", read);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`${command} took longer than five minutes.`));
      try {
        child.kill("SIGKILL");
      } catch {
        // The deadline still ends the wait when the child has already gone.
      }
    }, INSTALL_DEADLINE_MS);
    timer.unref?.();
    child.stderr?.on("data", read);
    child.once("error", (error: Error) => finish(error));
    child.once("exit", (code: number | null) => {
      const last = stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
      finish(code === 0 ? undefined : new Error(`${command} exited ${code ?? 1}.${last === "" ? "" : ` ${last}`}`));
    });
  });
}

export function createUpdateService(input: {
  version: string;
  /** Real path of the running bin.js, with symlinks resolved. */
  entry: string;
  argv: readonly string[];
  cwd: string;
  deps?: UpdateDeps;
}): UpdateService & { setPort(port: number): void } {
  const deps = input.deps ?? {};
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 4000;
  const statePath = deps.statePath ?? join(homedir(), ".leglas", "update.json");
  const install = detectInstall(input.entry, input.cwd, deps.exists ?? existsSync);
  const spawn = deps.spawn ?? spawnChild;
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const argv = [...input.argv];
  let { latest, checkedAt, skipped } = readState(statePath);
  let checkError: string | null = null;
  let phase: UpdatePhase = { status: "idle" };
  let checking: Promise<UpdateStatus> | null = null;
  let writing = Promise.resolve();
  let port = 4100;
  let busy = (): boolean => false;
  let restart: ((command: RestartCommand) => Promise<void>) | null = null;

  const available = (): boolean => latest !== null && compareVersions(latest.version, input.version) > 0;
  const status = (): UpdateStatus => ({
    version: input.version,
    install: { ...install },
    latest: latest === null ? null : { ...latest },
    checkedAt,
    checkError,
    skipped,
    available: available(),
    phase: { ...phase },
    busy: busy(),
  });
  const persist = (): Promise<void> => {
    const state = { latest, checkedAt, skipped };
    writing = writing.then(() => writeState(statePath, state));
    return writing;
  };
  const performUpdate = async (version: string, handoff: (command: RestartCommand) => Promise<void>): Promise<void> => {
    try {
      if (install.kind !== "npx") await installVersion(install, version, { spawn, platform, env, log });
      phase = { status: "restarting", version };
      log(`Restarting Leglas with ${version}…`);
      await handoff(restartCommand(install, argv, version, port, { execPath, platform }));
    } catch (error) {
      phase = { status: "failed", version, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    status,
    check(options = {}): Promise<UpdateStatus> {
      if (checking !== null) return checking;
      if (!options.force && latest !== null && checkedAt !== null) {
        const age = now() - Date.parse(checkedAt);
        if (age >= 0 && age < DAY_MS) return Promise.resolve(status());
      }
      // A concurrent check must not hide an install and allow a second one.
      if (phase.status !== "installing" && phase.status !== "restarting") phase = { status: "checking" };
      checking = (async () => {
        try {
          const [version, titles] = await Promise.all([
            registryVersion(fetcher, timeoutMs),
            releaseTitles(fetcher, timeoutMs),
          ]);
          latest = { version, title: titles.get(version) ?? null, url: releaseUrl(version) };
          checkedAt = new Date(now()).toISOString();
          checkError = null;
          if (skipped !== null && compareVersions(version, skipped) > 0) skipped = null;
          await persist();
        } catch (error) {
          checkError = error instanceof Error ? error.message : "Could not reach npm.";
        } finally {
          if (phase.status === "checking") phase = { status: "idle" };
          checking = null;
        }
        return status();
      })();
      return checking;
    },
    async skip(version): Promise<UpdateStatus> {
      if (latest?.version !== version) throw new Error("That is not the newest version.");
      skipped = version;
      await persist();
      return status();
    },
    async update(): Promise<UpdateStatus> {
      if (!available()) throw new Error("You have the newest version.");
      if (install.kind === "source") throw new Error(CHECKOUT_NOTICE);
      if (busy()) throw new Error("A change is running. Wait for it to finish.");
      if (phase.status === "installing" || phase.status === "restarting") throw new Error("An update is already running.");
      if (restart === null) throw new Error("Updates are not available here.");
      const version = latest!.version;
      const handoff = restart;
      phase = { status: "installing", version };
      // The route must answer before a fast npx handoff can close its socket.
      setImmediate(() => void performUpdate(version, handoff));
      return status();
    },
    notice(): string | null {
      if (!available() || latest === null || latest.version === skipped) return null;
      const title = latest.title === null ? "" : `: ${latest.title}`;
      const next = install.kind === "source"
        ? CHECKOUT_NOTICE
        : install.kind === "npx"
          ? "Update from the interface, or start Leglas again with npx leglas@latest"
          : `Update from the interface, or run ${install.command}`;
      return `update   ${latest.version} is out, you have ${input.version}${title}\n         ${next}`;
    },
    onRestart(handler): void { restart = handler; },
    onBusy(handler): void { busy = handler; },
    setPort(value): void { port = value; },
  };
}
