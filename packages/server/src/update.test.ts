import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  compareVersions,
  createUpdateService,
  detectInstall,
  restartCommand,
  type Install,
  type UpdateDeps,
} from "./update.js";

const directories: string[] = [];
const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/leglas/latest";
const SITE = "https://leglas.vercel.app/releases.json";
const release = (version = "1.1.0", title: string | null = "A release") => ({
  version,
  title,
  url: `https://leglas.vercel.app/changelog/#v${version}`,
});

function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "leglas-update-")));
  directories.push(path);
  return path;
}

function fetcher(version = "1.1.0", title = "A release") {
  return vi.fn<typeof fetch>(async (input) => String(input) === REGISTRY
    ? Response.json({ version })
    : Response.json([{ version, date: "2026-09-07", title }]));
}

function service(options: {
  entry?: string;
  cwd?: string;
  version?: string;
  deps?: UpdateDeps;
  cached?: boolean;
} = {}) {
  const statePath = options.deps?.statePath ?? join(temporary(), "update.json");
  if (options.cached) writeFileSync(statePath, JSON.stringify({
    checkedAt: new Date(NOW).toISOString(), latest: release(), skipped: null,
  }));
  return createUpdateService({
    version: options.version ?? "1.0.0",
    entry: options.entry ?? "/opt/lib/node_modules/leglas/dist/bin.js",
    argv: ["/runtime/node", "/opt/bin/leglas", "--port", "4105"],
    cwd: options.cwd ?? "/work/app",
    deps: {
      statePath,
      now: () => NOW,
      fetch: fetcher(),
      exists: () => false,
      platform: "linux",
      execPath: "/runtime/node",
      log: vi.fn(),
      ...options.deps,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function spawned() {
  const child = new FakeChild();
  const spawn = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
  return { spawn, child };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("detectInstall", () => {
  test.each([
    ["/cache/_npx/hash/node_modules/leglas/dist/bin.js", "/cache/_npx/hash", [], { kind: "npx", manager: "npm", command: "npx leglas@latest" }],
    ["C:\\Users\\tester\\_npx\\hash\\node_modules\\leglas\\dist\\bin.js", "C:\\work", [], { kind: "npx", manager: "npm", command: "npx leglas@latest" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "project", manager: "npm", command: "npm install leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app/src/ui", ["pnpm-lock.yaml", "yarn.lock"], { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/work/app" }],
    // pnpm's real path runs through its store; the project is still the first node_modules.
    ["/work/app/node_modules/.pnpm/leglas@1.0.0/node_modules/leglas/dist/bin.js", "/work/app", ["pnpm-lock.yaml"], { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/work/app" }],
    ["/tools/pnpm/global/5/.pnpm/leglas@1.0.0/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["yarn.lock"], { kind: "project", manager: "yarn", command: "yarn upgrade leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["yarn.lock", ".yarnrc.yml"], { kind: "project", manager: "yarn", command: "yarn up leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["bun.lock"], { kind: "project", manager: "bun", command: "bun update leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["bun.lockb"], { kind: "project", manager: "bun", command: "bun update leglas@latest", root: "/work/app" }],
    ["C:\\work\\app\\node_modules\\leglas\\dist\\bin.js", "c:\\work\\app\\src", ["pnpm-lock.yaml"], { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "C:/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/apple", [], { kind: "global", manager: "npm", command: "npm i -g leglas@latest" }],
    ["/opt/lib/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "npm", command: "npm i -g leglas@latest" }],
    ["/tools/pnpm/global/5/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" }],
    ["/tools/.yarn/global/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "yarn", command: "yarn global add leglas@latest" }],
    ["/tools/yarn/global/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "yarn", command: "yarn global add leglas@latest" }],
    ["/tools/.bun/install/global/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "bun", command: "bun add -g leglas@latest" }],
    ["C:\\Users\\tester\\node_modules\\leglas\\dist\\bin.js", "D:\\app", [], { kind: "global", manager: "npm", command: "npm i -g leglas@latest" }],
    ["/work/leglas/packages/cli/dist/bin.js", "/work/leglas", [], { kind: "source", manager: "npm", command: null }],
    ["C:\\work\\leglas\\packages\\cli\\dist\\bin.js", "C:\\work\\leglas", [], { kind: "source", manager: "npm", command: null }],
  ] as const)("classifies %s from %s", (entry, cwd, files, expected) => {
    const root = entry.replaceAll("\\", "/").split("/node_modules/")[0]!;
    const exists = (path: string): boolean => files.some((file) => path === `${root}/${file}`);
    expect(detectInstall(entry, cwd, exists)).toEqual(expected);
  });

  test("compares a symlinked working directory with the real package directory", () => {
    const root = temporary();
    const project = join(root, "app");
    mkdirSync(project);
    symlinkSync(project, join(root, "linked"));
    expect(detectInstall(`${project}/node_modules/leglas/dist/bin.js`, join(root, "linked"), () => false))
      .toMatchObject({ kind: "project", root: project });
  });
});

describe("compareVersions", () => {
  test.each([
    ["1.0.0", "1.1.0", -1], ["1.0.9", "1.0.10", -1],
    ["1.1.0-rc.1", "1.1.0", -1], ["2.0.0", "1.99.99", 1],
    ["1.0.0-rc.9", "1.0.0-rc.10", -1], ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-1", "1.0.0-alpha", -1], ["1.0.0-rc", "1.0.0-rc.1", -1],
    ["1.0.0+build.9", "1.0.0+build.10", 0], ["1.0.0", "1.0.0", 0],
    ["no version", "1.0.0", 0], ["1.0", "2.0.0", 0],
    ["01.0.0", "1.0.0", 0], ["1.0.0-01", "1.0.0", 0],
  ] as const)("compares %s with %s", (a, b, result) => {
    expect(compareVersions(a, b)).toBe(result);
    expect(compareVersions(b, a)).toBe(result === 0 ? 0 : -result);
  });
});

describe("checking and remembering", () => {
  test("reads a fresh cache once and makes no network request", async () => {
    const path = join(temporary(), "update.json");
    const fetch = fetcher();
    const updates = service({ cached: true, deps: { statePath: path, fetch } });
    writeFileSync(path, "not JSON");
    expect(updates.status()).toMatchObject({ latest: release(), checkedAt: new Date(NOW).toISOString(), available: true });
    expect(await updates.check()).toEqual(updates.status());
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([DAY, DAY + 1, -1])("does not reuse a cache aged %s milliseconds", async (age) => {
    const fetch = fetcher();
    const updates = service({ cached: true, deps: { fetch, now: () => NOW + age } });
    await updates.check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("force asks both sources even with a fresh cache and remembers the site's title", async () => {
    const fetch = fetcher("1.2.0", "A clearer rail");
    const path = join(temporary(), "update.json");
    const updates = service({ cached: true, deps: { fetch, statePath: path } });
    const checking = updates.check({ force: true });
    expect(updates.status().phase).toEqual({ status: "checking" });
    expect(await checking).toMatchObject({ latest: release("1.2.0", "A clearer rail"), phase: { status: "idle" }, checkError: null });
    for (const url of [REGISTRY, SITE]) expect(fetch).toHaveBeenCalledWith(url, {
      headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      checkedAt: new Date(NOW).toISOString(), latest: release("1.2.0", "A clearer rail"), skipped: null,
    });
    expect(readdirSync(join(path, ".."))).toEqual(["update.json"]);
  });

  test.each([
    ["timeout", () => Promise.reject(new DOMException("Expired", "TimeoutError")), "npm took too long to answer."],
    ["network", () => Promise.reject(new TypeError("offline")), "Could not reach npm."],
    ["500", async () => new Response("error", { status: 500 }), "npm answered 500."],
    ["bad JSON", async () => new Response("{"), "npm's answer made no sense."],
    ["missing version", async () => Response.json({}), "npm's answer made no sense."],
    ["non-object", async () => Response.json(null), "npm's answer made no sense."],
    ["invalid version", async () => Response.json({ version: "1.2.0;bad" }), "npm's answer made no sense."],
  ] as const)("reports %s without losing the cache", async (_name, answer, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url) === REGISTRY ? answer() : Response.json([]));
    const updates = service({ cached: true, deps: { fetch } });
    const status = await updates.check({ force: true });
    expect(status).toMatchObject({ checkError: error, latest: release(), checkedAt: new Date(NOW).toISOString(), phase: { status: "idle" } });
  });

  test("uses the configured abort deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await service({ deps: { timeoutMs: 75 } }).check();
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 75);
    expect(timeout).toHaveBeenNthCalledWith(2, 75);
  });

  test.each(["offline", "bad JSON", "500", "missing version"])("keeps the npm result when the site has %s", async (failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === REGISTRY) return Response.json({ version: "1.1.0" });
      if (failure === "offline") throw new Error("offline");
      if (failure === "bad JSON") return new Response("{");
      return Response.json([], { status: failure === "500" ? 500 : 200 });
    });
    const status = await service({ deps: { fetch } }).check();
    expect(status).toMatchObject({ latest: release("1.1.0", null), checkError: null, available: true });
  });

  test("joins concurrent checks while asking the registry and the site in parallel", async () => {
    const npm = deferred<Response>();
    const site = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url) === REGISTRY ? npm.promise : site.promise);
    const updates = service({ deps: { fetch } });
    const first = updates.check();
    const second = updates.check({ force: true });
    expect(first).toBe(second);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([REGISTRY, SITE]);
    site.resolve(Response.json([{ version: "1.1.0", title: "From the site" }]));
    npm.resolve(Response.json({ version: "1.1.0" }));
    expect(await first).toEqual(await second);
    expect(updates.status().latest?.title).toBe("From the site");
  });

  test("clears an old skip only when a newer release appears", async () => {
    const fetch = fetcher();
    const updates = service({ cached: true, deps: { fetch } });
    await updates.skip("1.1.0");
    await updates.check({ force: true });
    expect(updates.status().skipped).toBe("1.1.0");
    fetch.mockImplementation(async (url) => String(url) === REGISTRY ? Response.json({ version: "1.2.0" }) : Response.json([]));
    expect((await updates.check({ force: true })).skipped).toBeNull();
    expect(updates.notice()).not.toBeNull();
  });

  test.each(["{", "null", "{}", '{"checkedAt":"never","latest":null,"skipped":null}'])
    ("treats malformed state as empty: %s", async (body) => {
      const statePath = join(temporary(), "update.json");
      writeFileSync(statePath, body);
      const updates = service({ deps: { statePath } });
      expect(updates.status()).toMatchObject({ latest: null, checkedAt: null, checkError: null, skipped: null });
      expect((await updates.check()).available).toBe(true);
    });

  test("creates missing state directories and reads a saved skip on the next start", async () => {
    const statePath = join(temporary(), "nested", "update.json");
    const updates = service({ deps: { statePath } });
    expect(updates.notice()).toBeNull();
    await updates.check();
    await updates.skip("1.1.0");
    const next = service({ deps: { statePath } });
    expect(next.status()).toMatchObject({ skipped: "1.1.0", available: true });
    expect(next.notice()).toBeNull();
  });

  test("a refused state write does not fail a check or a skip", async () => {
    const path = join(temporary(), "file");
    writeFileSync(path, "keep me");
    const updates = service({ deps: { statePath: join(path, "update.json") } });
    expect((await updates.check()).checkError).toBeNull();
    expect((await updates.skip("1.1.0")).skipped).toBe("1.1.0");
    expect(readFileSync(path, "utf8")).toBe("keep me");
  });

  test("does not write through a state-file symlink", async () => {
    const root = temporary();
    const original = join(root, "other.json");
    writeFileSync(original, "keep me");
    const statePath = join(root, "update.json");
    symlinkSync(original, statePath);
    expect((await service({ deps: { statePath } }).check()).checkError).toBeNull();
    expect(readFileSync(original, "utf8")).toBe("keep me");
  });

  test("a caller cannot change the service by editing a returned snapshot", () => {
    const updates = service({ cached: true });
    const status = updates.status();
    status.latest!.version = "9.0.0";
    status.install.kind = "source";
    status.phase.status = "checking";
    expect(updates.status()).toMatchObject({ latest: release(), install: { kind: "global" }, phase: { status: "idle" } });
  });
});

describe("skips and terminal notices", () => {
  test("only the newest known version can be skipped", async () => {
    const updates = service({ cached: true });
    await expect(updates.skip("1.0.1")).rejects.toThrow("That is not the newest version.");
    expect((await updates.skip("1.1.0")).available).toBe(true);
    expect(updates.notice()).toBeNull();
    await expect(service().skip("1.1.0")).rejects.toThrow("That is not the newest version.");
  });

  test.each([
    ["/cache/_npx/hash/node_modules/leglas/dist/bin.js", "Update from the interface, or start Leglas again with npx leglas@latest"],
    ["/opt/lib/node_modules/leglas/dist/bin.js", "Update from the interface, or run npm i -g leglas@latest"],
    ["/work/app/node_modules/leglas/dist/bin.js", "Update from the interface, or run npm install leglas@latest"],
    ["/work/leglas/packages/cli/dist/bin.js", "You run Leglas from a checkout, so pull to update."],
  ])("prints an aligned notice for %s", (entry, next) => {
    expect(service({ entry, cached: true }).notice()).toBe(`update   1.1.0 is out, you have 1.0.0: A release\n         ${next}`);
  });

  test("omits the colon when no title was found", async () => {
    const updates = service({ deps: { fetch: async (url) => Response.json(String(url) === REGISTRY ? { version: "1.1.0" } : []) } });
    await updates.check();
    expect(updates.notice()?.split("\n")[0]).toBe("update   1.1.0 is out, you have 1.0.0");
  });

  test.each(["1.1.0", "2.0.0"])("has no notice when running %s", (version) => {
    const updates = service({ cached: true, version });
    expect(updates.status().available).toBe(false);
    expect(updates.notice()).toBeNull();
  });
});

describe("restartCommand", () => {
  const argv = ["node", "/invoked/leglas", "--port", "4105", "--user-port", "3001", "--port=4106", "--no-open"];
  const options = { execPath: "/runtime/node", platform: "linux" as const };
  const rest = ["--user-port", "3001", "--port", "4123", "--no-open"];

  test("pins npx and replaces both forms of the old port", () => {
    const install: Install = { kind: "npx", manager: "npm", command: "npx leglas@latest" };
    expect(restartCommand(install, argv, "1.1.0", 4123, options)).toEqual({ file: "npx", args: ["-y", "leglas@1.1.0", ...rest], shell: false });
    expect(restartCommand(install, argv, "1.1.0", 4123, { ...options, platform: "win32" }).shell).toBe(true);
    expect(argv[3]).toBe("4105");
  });

  test("uses the invoked global bin with the same runtime", () => {
    const install: Install = { kind: "global", manager: "npm", command: "npm i -g leglas@latest" };
    expect(restartCommand(install, argv, "1.1.0", 4123, { ...options, platform: "win32" }))
      .toEqual({ file: "/runtime/node", args: ["/invoked/leglas", ...rest], shell: false });
  });

  test("uses the project's shim on either platform", () => {
    const install: Install = { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/work/app" };
    expect(restartCommand(install, argv, "1.1.0", 4123, options)).toEqual({ file: "/work/app/node_modules/.bin/leglas", args: rest, shell: false });
    expect(restartCommand({ ...install, root: "C:/work/app" }, argv, "1.1.0", 4123, { ...options, platform: "win32" }))
      .toEqual({ file: "C:\\work\\app\\node_modules\\.bin\\leglas.cmd", args: rest, shell: true });
  });
});

describe("installing and restarting", () => {
  test("rejects every unavailable update before starting a process", async () => {
    await expect(service().update()).rejects.toThrow("You have the newest version.");
    await expect(service({ cached: true, entry: "/source/packages/cli/dist/bin.js" }).update()).rejects.toThrow("You run Leglas from a checkout, so pull to update.");
    const updates = service({ cached: true });
    updates.onBusy(() => true);
    expect(updates.status().busy).toBe(true);
    await expect(updates.update()).rejects.toThrow("A change is running. Wait for it to finish.");
    updates.onBusy(() => false);
    await expect(updates.update()).rejects.toThrow("Updates are not available here.");
  });

  test("npx answers installing before handing off the pinned version on the bound port", async () => {
    const { spawn } = spawned();
    const log = vi.fn();
    const updates = service({ cached: true, entry: "/cache/_npx/hash/node_modules/leglas/dist/bin.js", deps: { spawn, log } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    updates.setPort(4123);
    expect((await updates.update()).phase).toEqual({ status: "installing", version: "1.1.0" });
    expect(restart).not.toHaveBeenCalled();
    await expect(updates.update()).rejects.toThrow("An update is already running.");
    await nextTurn();
    expect(spawn).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledWith({ file: "npx", args: ["-y", "leglas@1.1.0", "--port", "4123", "--no-open"], shell: false });
    expect(updates.status().phase).toEqual({ status: "restarting", version: "1.1.0" });
    await expect(updates.update()).rejects.toThrow("An update is already running.");
    expect(log.mock.calls).toEqual([["Restarting Leglas with 1.1.0…"]]);
  });

  test.each([
    ["/opt/lib/node_modules/leglas/dist/bin.js", [], "npm", ["i", "-g", "leglas@1.1.0"], undefined],
    ["/tools/pnpm/global/node_modules/leglas/dist/bin.js", [], "pnpm", ["add", "-g", "leglas@1.1.0"], undefined],
    ["/tools/.yarn/global/node_modules/leglas/dist/bin.js", [], "yarn", ["global", "add", "leglas@1.1.0"], undefined],
    ["/tools/.bun/global/node_modules/leglas/dist/bin.js", [], "bun", ["add", "-g", "leglas@1.1.0"], undefined],
    ["/work/app/node_modules/leglas/dist/bin.js", [], "npm", ["install", "leglas@1.1.0"], "/work/app"],
    ["/work/app/node_modules/leglas/dist/bin.js", ["pnpm-lock.yaml"], "pnpm", ["up", "leglas@1.1.0"], "/work/app"],
    ["/work/app/node_modules/leglas/dist/bin.js", ["yarn.lock"], "yarn", ["upgrade", "leglas@1.1.0"], "/work/app"],
    ["/work/app/node_modules/leglas/dist/bin.js", ["yarn.lock", ".yarnrc.yml"], "yarn", ["up", "leglas@1.1.0"], "/work/app"],
    ["/work/app/node_modules/leglas/dist/bin.js", ["bun.lock"], "bun", ["update", "leglas@1.1.0"], "/work/app"],
  ] as const)("pins the install for %s with %s", async (entry, files, manager, args, cwd) => {
    const { spawn, child } = spawned();
    const log = vi.fn();
    const updates = service({ cached: true, entry, deps: { spawn, log, env: { PATH: "/tools" }, exists: (path) => files.some((file) => path === `/work/app/${file}`) } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    expect(spawn).toHaveBeenCalledWith(manager, args, { stdio: ["ignore", "ignore", "pipe"], shell: false, env: { PATH: "/tools" }, ...(cwd === undefined ? {} : { cwd }) });
    expect(log).toHaveBeenNthCalledWith(1, `Updating Leglas to 1.1.0 with ${[manager, ...args].join(" ")}…`);
    expect(restart).not.toHaveBeenCalled();
    child.emit("exit", 0);
    await nextTurn();
    expect(restart).toHaveBeenCalledOnce();
    expect(log).toHaveBeenNthCalledWith(2, "Restarting Leglas with 1.1.0…");
  });

  test("a concurrent check cannot hide the install or change its pinned version", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn, fetch: fetcher("1.2.0") } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    const check = updates.check({ force: true });
    expect(updates.status().phase.status).toBe("installing");
    await check;
    await nextTurn();
    await expect(updates.update()).rejects.toThrow("An update is already running.");
    child.emit("exit", 0);
    await nextTurn();
    expect(updates.status().phase).toEqual({ status: "restarting", version: "1.1.0" });
  });

  test("uses a shell for Windows managers", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn, platform: "win32" } });
    updates.onRestart(async () => {});
    await updates.update();
    await nextTurn();
    expect(spawn).toHaveBeenCalledWith("npm", ["i", "-g", "leglas@1.1.0"], expect.objectContaining({ shell: true }));
    child.emit("exit", 0);
    await nextTurn();
  });

  test("a failed install includes the code and the last available stderr line", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    child.stderr.write("Earlier line.\nNo permission");
    child.stderr.write(" to install.\n");
    child.emit("exit", 7);
    await nextTurn();
    expect(updates.status().phase).toEqual({ status: "failed", version: "1.1.0", reason: "npm i -g leglas@1.1.0 exited 7. No permission to install." });
    expect(restart).not.toHaveBeenCalled();
  });

  test.each(["event", "throw"])("a spawn %s reports its message", async (kind) => {
    const { spawn, child } = spawned();
    if (kind === "throw") vi.mocked(spawn).mockImplementation(() => { throw new Error("The manager could not start."); });
    const updates = service({ cached: true, deps: { spawn } });
    updates.onRestart(async () => {});
    await updates.update();
    await nextTurn();
    if (kind === "event") child.emit("error", new Error("The manager could not start."));
    await nextTurn();
    expect(updates.status().phase).toEqual({ status: "failed", version: "1.1.0", reason: "The manager could not start." });
  });

  test("a rejecting restart leaves a readable failure", async () => {
    const updates = service({ cached: true, entry: "/cache/_npx/hash/node_modules/leglas/dist/bin.js" });
    updates.onRestart(async () => { throw new Error("The server could not stop."); });
    await updates.update();
    await nextTurn();
    expect(updates.status().phase).toEqual({ status: "failed", version: "1.1.0", reason: "The server could not stop." });
  });

  test("the five-minute deadline kills a child even when it never exits", async () => {
    vi.useFakeTimers();
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(updates.status().phase).toEqual({ status: "failed", version: "1.1.0", reason: "npm i -g leglas@1.1.0 took longer than five minutes." });
    child.emit("exit", 0);
    expect(restart).not.toHaveBeenCalled();
  });
});
