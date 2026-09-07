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
  installerReason,
  windowsLine,
  restartCommand,
  type Install,
  type UpdateDeps,
  type UpdateStatus,
} from "./update.js";

import { DEFAULT_PORT } from "./server.js";

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
  if (options.cached && statePath !== null) writeFileSync(statePath, JSON.stringify({
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
      exists: (path) => path === "/opt/bin/leglas" || path === "/work/app/node_modules/.bin/leglas",
      realpath: (path) => path === "/work/app/node_modules/leglas" && options.entry?.startsWith("/work/app/")
        ? options.entry.slice(0, options.entry.lastIndexOf("/node_modules/leglas/") + "/node_modules/leglas".length) : null,
      env: {},
      kill: vi.fn<typeof process.kill>(() => true),
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
  pid: number | undefined = 12345;
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
    // The project dependency resolves into pnpm's store.
    ["/work/app/node_modules/.pnpm/leglas@1.0.0/node_modules/leglas/dist/bin.js", "/work/app", ["pnpm-lock.yaml"], { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/work/app" }],
    ["/tools/pnpm/global/5/.pnpm/leglas@1.0.0/node_modules/leglas/dist/bin.js", "/work/app", [], { kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["yarn.lock"], { kind: "project", manager: "yarn", command: "yarn upgrade leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["yarn.lock", ".yarnrc.yml"], { kind: "project", manager: "yarn", command: "yarn up leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["bun.lock"], { kind: "project", manager: "bun", command: "bun update leglas@latest", root: "/work/app" }],
    ["/work/app/node_modules/leglas/dist/bin.js", "/work/app", ["bun.lockb"], { kind: "project", manager: "bun", command: "bun update leglas@latest", root: "/work/app" }],
    ["C:\\work\\app\\node_modules\\leglas\\dist\\bin.js", "c:\\work\\app\\src", ["pnpm-lock.yaml"], { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "c:/work/app" }],
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
    const root = expected.kind === "project" ? expected.root : entry.replaceAll("\\", "/").split("/node_modules/")[0]!;
    const exists = (path: string): boolean => files.some((file) => path === `${root}/${file}`);
    const path = entry.replaceAll("\\", "/");
    const realpath = (value: string): string | null => value === `${root}/node_modules/leglas`
      ? path.slice(0, path.lastIndexOf("/node_modules/leglas/") + "/node_modules/leglas".length) : null;
    expect(detectInstall(entry, cwd, exists, realpath, {})).toEqual(expected);
  });

  test("compares a symlinked working directory with the real package directory", () => {
    const root = temporary();
    const project = join(root, "app");
    mkdirSync(join(project, "node_modules", "leglas"), { recursive: true });
    symlinkSync(project, join(root, "linked"));
    expect(detectInstall(`${project}/node_modules/leglas/dist/bin.js`, join(root, "linked"), () => false, undefined, {}))
      .toMatchObject({ kind: "project", root: project });
  });
});

describe("runner and workspace installs", () => {
  test.each([
    ["/cache/pnpm/dlx/hash/node_modules/leglas/dist/bin.js", "pnpm", "pnpm dlx leglas@latest"],
    ["C:\\cache\\pnpm\\dlx\\hash\\node_modules\\leglas\\dist\\bin.js", "pnpm", "pnpm dlx leglas@latest"],
    ["/private/tmp/bunx-501-leglas@latest/node_modules/leglas/dist/bin.js", "bun", "bunx leglas@latest"],
    ["/private/var/folders/aa/hash/T/dlx-abc/node_modules/leglas/dist/bin.js", "yarn", "yarn dlx leglas@latest"],
  ] as const)("recognizes %s before project or environment detection", (entry, manager, command) => {
    expect(detectInstall(entry, "/work/app", () => true, () => null, { npm_config_user_agent: "npm/11.0.0" }))
      .toEqual({ kind: "npx", manager, command });
  });

  test.each(["pnpm", "bun", "yarn"] as const)("uses the %s user agent only for anonymous runner caches", (manager) => {
    const env = { npm_config_user_agent: `${manager}/1.0 npm/?` };
    const commands = { pnpm: "pnpm dlx leglas@latest", bun: "bunx leglas@latest", yarn: "yarn dlx leglas@latest" };
    for (const root of ["/cache/runner/hash", "/private/var/folders/aa/hash/T/runner", "C:/Users/tester/AppData/Local/Temp/runner"]) {
      expect(detectInstall(`${root}/node_modules/leglas/dist/bin.js`, "/work/app", () => false, () => null, env))
        .toEqual({ kind: "npx", manager, command: commands[manager] });
    }
    expect(detectInstall("/tools/lib/node_modules/leglas/dist/bin.js", "/work/app", () => false, () => null, env))
      .toMatchObject({ kind: "global", manager });
    expect(detectInstall("/tmp/leglas/packages/cli/dist/bin.js", "/tmp/leglas", () => false, () => null, env))
      .toMatchObject({ kind: "source" });
  });

  test("recognizes a pnpm dlx entry resolved into the links store", () => {
    const entry = "/tools/pnpm/store/v11/links/leglas/1.0.0/hash/node_modules/leglas/dist/bin.js";
    expect(detectInstall(entry, "/work/app", () => false, () => null, { npm_config_user_agent: "pnpm/11.20.0 npm/?" }))
      .toEqual({ kind: "npx", manager: "pnpm", command: "pnpm dlx leglas@latest" });
  });

  test("does not infer a runner from an incomplete user agent", () => {
    expect(detectInstall("/cache/hash/node_modules/leglas/dist/bin.js", "/work/app", () => false, () => null, { npm_config_user_agent: "pnpm" }))
      .toEqual({ kind: "global", manager: "npm", command: "npm i -g leglas@latest" });
  });

  test.each([
    "/work/repo/.yarn/cache/leglas-npm-1.0.0.zip/node_modules/leglas/dist/bin.js",
    "/tools/.yarn/berry/cache/leglas-npm-1.0.0.zip/node_modules/leglas/dist/bin.js",
    "/work/repo/.yarn/unplugged/leglas-npm-1.0.0/node_modules/leglas/dist/bin.js",
  ])("finds the nearest Berry project for %s", (entry) => {
    const files = new Set(["/work/yarn.lock", "/work/.yarnrc.yml", "/work/repo/yarn.lock", "/work/repo/.yarnrc.yml"]);
    expect(detectInstall(entry, "/work/repo/packages/web", (path) => files.has(path), () => null, { npm_config_user_agent: "yarn/4.0.0" }))
      .toEqual({ kind: "project", manager: "yarn", command: "yarn up leglas@latest", root: "/work/repo" });
    expect(detectInstall(entry, "/elsewhere", () => false, () => null, {}))
      .toEqual({ kind: "source", manager: "yarn", command: null });
  });

  test.each([
    [["pnpm-lock.yaml"], "pnpm", "pnpm up leglas@latest"],
    [["yarn.lock", ".yarnrc.yml"], "yarn", "yarn up leglas@latest"],
    [["yarn.lock"], "yarn", "yarn upgrade leglas@latest"],
    [["bun.lockb"], "bun", "bun update leglas@latest"],
    [["package-lock.json"], "npm", "npm install leglas@latest"],
  ] as const)("runs in the workspace member with the lockfile %s above it", (files, manager, command) => {
    const packagePath = "/work/repo/node_modules/.pnpm/leglas@1.0.0/node_modules/leglas";
    const links = new Map([
      ["/work/repo/packages/web/node_modules/leglas", packagePath],
      ["/work/repo/node_modules/leglas", packagePath],
    ]);
    expect(detectInstall(`${packagePath}/dist/bin.js`, "/work/repo/packages/web/src", (path) => files.some((file) => path === `/work/repo/${file}`), (path) => links.get(path) ?? null, {}))
      .toEqual({ kind: "project", manager, command, root: "/work/repo/packages/web" });
  });

  test("a different project dependency does not claim the global entry", () => {
    expect(detectInstall("/tools/pnpm/global/node_modules/leglas/dist/bin.js", "/work/app", () => true,
      (path) => path.endsWith("/node_modules/leglas") ? "/work/app/node_modules/leglas" : null, { npm_config_user_agent: "yarn/1.0.0" }))
      .toEqual({ kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" });
  });

  test("uses the closest lockfile instead of an outer workspace's manager", () => {
    const packagePath = "/work/repo/packages/web/node_modules/leglas";
    expect(detectInstall(`${packagePath}/dist/bin.js`, "/work/repo/packages/web", (path) =>
      path === "/work/repo/pnpm-lock.yaml" || path === "/work/repo/packages/web/package-lock.json",
    (path) => path === packagePath ? packagePath : null, {}))
      .toMatchObject({ manager: "npm", command: "npm install leglas@latest", root: "/work/repo/packages/web" });
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
  const options = { execPath: "/runtime/node", platform: "linux" as const, exists: () => true };
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
      .toEqual({ file: `C:\\work\\app\\node_modules\\.bin\\leglas.cmd ${rest.join(" ")}`, args: [], shell: true });
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
    ["/work/app/.yarn/cache/leglas-npm-1.0.0.zip/node_modules/leglas/dist/bin.js", ["yarn.lock", ".yarnrc.yml"], "yarn", ["up", "leglas@1.1.0"], "/work/app"],
    ["/work/app/node_modules/leglas/dist/bin.js", ["bun.lock"], "bun", ["update", "leglas@1.1.0"], "/work/app"],
  ] as const)("pins the install for %s with %s", async (entry, files, manager, args, cwd) => {
    const { spawn, child } = spawned();
    const log = vi.fn();
    const updates = service({ cached: true, entry, deps: { spawn, log, env: { PATH: "/tools" }, exists: (path) => files.some((file) => path === `/work/app/${file}`) } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    expect(spawn).toHaveBeenCalledWith(manager, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true, env: { PATH: "/tools" }, ...(cwd === undefined ? {} : { cwd }) });
    expect(log).toHaveBeenNthCalledWith(1, `Updating Leglas to 1.1.0 with ${[manager, ...args].join(" ")}…`);
    expect(restart).not.toHaveBeenCalled();
    child.emit("close", 0);
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
    child.emit("close", 0);
    await nextTurn();
    expect(updates.status().phase).toEqual({ status: "restarting", version: "1.1.0" });
  });

  test("uses a shell for Windows managers", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn, platform: "win32" } });
    updates.onRestart(async () => {});
    await updates.update();
    await nextTurn();
    expect(spawn).toHaveBeenCalledWith("npm i -g leglas@1.1.0", [], expect.objectContaining({ shell: true, detached: false }));
    child.emit("close", 0);
    await nextTurn();
  });

  test("a failed install includes the code and the first useful stderr line", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    child.stderr.write("No permission");
    child.stderr.write(" to install.\n");
    child.emit("close", 7);
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
    if (kind === "event") child.pid = undefined;
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
    const kill = vi.fn<typeof process.kill>(() => true);
    const updates = service({ cached: true, deps: { spawn, kill } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(updates.status().phase).toEqual({ status: "failed", version: "1.1.0", reason: "npm i -g leglas@1.1.0 took longer than five minutes." });
    child.emit("close", 0);
    expect(restart).not.toHaveBeenCalled();
  });
});


describe("Windows command lines and replacement bins", () => {
  const options = { platform: "linux" as const, execPath: "/runtime/node", exists: () => false };
  const argv = ["node", "/removed/pnpm/random/node_modules/leglas/dist/bin.js", "--config", "/work/my app/leglas.config.ts"];

  test.each([
    ["npm", "npx", ["-y", "leglas@1.2.0"]],
    ["pnpm", "pnpm", ["dlx", "leglas@1.2.0"]],
    ["bun", "bunx", ["leglas@1.2.0"]],
    ["yarn", "yarn", ["dlx", "leglas@1.2.0"]],
  ] as const)("pins the %s runner", (manager, file, args) => {
    expect(restartCommand({ kind: "npx", manager, command: null }, argv, "1.2.0", 4123, options))
      .toEqual({ file, args: [...args, ...argv.slice(2), "--port", "4123", "--no-open"], shell: false });
  });

  test("uses PATH after pnpm removes the previous global directory", () => {
    expect(restartCommand({ kind: "global", manager: "pnpm", command: "pnpm add -g leglas@latest" }, argv, "1.2.0", 4123, options))
      .toEqual({ file: "leglas", args: [...argv.slice(2), "--port", "4123", "--no-open"], shell: false });
  });

  test("a surviving custom prefix runs through its original runtime", () => {
    const exists = vi.fn((path: string) => path === argv[1]);
    expect(restartCommand({ kind: "global", manager: "npm", command: null }, argv, "1.2.0", 4123, { ...options, exists }))
      .toMatchObject({ file: "/runtime/node", args: argv.slice(1).concat(["--port", "4123", "--no-open"]), shell: false });
    expect(exists).toHaveBeenCalledWith(argv[1]);
  });

  test("PnP restarts through yarn when the project has no bin shim", () => {
    expect(restartCommand({ kind: "project", manager: "yarn", command: "yarn up leglas@latest", root: "/work/pnp" }, argv, "1.2.0", 4123, options))
      .toEqual({ file: "yarn", args: ["leglas", ...argv.slice(2), "--port", "4123", "--no-open"], shell: false });
  });

  test("quotes a Windows project root and config path without shell arguments", () => {
    const command = restartCommand({ kind: "project", manager: "pnpm", command: null, root: "C:/my app" },
      ["node", "leglas", "--config", "C:/my app/leglas.config.ts"], "1.2.0", 4123,
      { ...options, platform: "win32", exists: () => true });
    expect(command).toEqual({
      file: '"C:\\my app\\node_modules\\.bin\\leglas.cmd" --config "C:/my app/leglas.config.ts" --port 4123 --no-open', args: [], shell: true,
    });
  });

  test("quotes empty values, embedded quotes and trailing backslashes", () => {
    expect(windowsLine(["yarn", "", 'a"b', "C:\\my app\\"]))
      .toBe(String.raw`yarn "" "a\"b" "C:\my app\\"`);
  });

  test.each(["npx", "global", "project"] as const)("%s uses a single line when Windows needs a shell", (kind) => {
    const command = restartCommand({ kind, manager: "yarn", command: null, root: "C:/my app" }, argv, "1.2.0", 4123, { ...options, platform: "win32" });
    expect(command.shell).toBe(true);
    expect(command.args).toEqual([]);
    expect(command.file).toContain('--config "/work/my app/leglas.config.ts"');
  });
});

describe("installerReason", () => {
  test.each([
    ["npm 11 E404", "", `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/leglas - Not found
npm error 404
npm error 404 'leglas@1.2.0' is not in this registry.
npm error A complete log of this run can be found in: /tmp/npm/_logs/run-debug-0.log`, "404 Not Found - GET https://registry.npmjs.org/leglas - Not found"],
    ["npm 11 EACCES", "", `npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/leglas
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/leglas'
    at async mkdir (node:internal/fs/promises:858:10)
npm error A complete log of this run can be found in: /tmp/npm/_logs/run-debug-0.log`, "syscall mkdir"],
    ["Yarn classic", "yarn global v1.22.22\ninfo Visit https://yarnpkg.com/en/docs/cli/global for documentation about this command.",
      "error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/leglas'\n    at Object.mkdirSync (node:fs:1363:26)\n    at /opt/yarn/lib/cli.js:841:17\n", "error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/leglas'"],
    ["pnpm stdout", "ERR_PNPM_NO_GLOBAL_BIN_DIR Unable to find the global bin directory\n\nRun pnpm setup to create it automatically.\n", "", "ERR_PNPM_NO_GLOBAL_BIN_DIR Unable to find the global bin directory"],
    ["bun", "", "error: EACCES: Permission denied (os error 13)\n", "error: EACCES: Permission denied (os error 13)"],
    ["only footer and stack", "", "    at Object.mkdirSync (node:fs:1:1)\ninfo Visit https://yarnpkg.com/en/docs/cli/add\nA complete log of this run is in /tmp/npm.log\n", null],
    ["empty", "\n", "\n", null],
  ])("extracts the reason from %s", (_name, stdout, stderr, expected) => {
    expect(installerReason(stdout!, stderr!)).toBe(expected);
  });
});

describe("shared update state", () => {
  test("merges a later check before an older process saves its skip", async () => {
    const statePath = join(temporary(), "update.json");
    const older = service({ cached: true, deps: { statePath } });
    const newer = service({ deps: { statePath, now: () => NOW + 1000, fetch: fetcher("1.2.0") } });
    await newer.check({ force: true });
    const changed = vi.fn();
    older.onChange(changed);
    const status = await older.skip("1.1.0");
    expect(status).toMatchObject({ latest: release("1.2.0"), checkedAt: new Date(NOW + 1000).toISOString(), skipped: null });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      latest: release("1.2.0"), checkedAt: new Date(NOW + 1000).toISOString(), skipped: null,
    });
  });

  test("an older writer preserves the newer skipped version", async () => {
    const statePath = join(temporary(), "update.json");
    const older = service({ cached: true, deps: { statePath } });
    const newer = service({ deps: { statePath, now: () => NOW + 1000, fetch: fetcher("1.2.0") } });
    await newer.check({ force: true });
    await newer.skip("1.2.0");
    expect((await older.skip("1.1.0")).skipped).toBe("1.2.0");
    expect(service({ deps: { statePath } }).status()).toMatchObject({ latest: release("1.2.0"), skipped: "1.2.0" });
  });

  test("checkedAt decides which latest wins, even when the version is lower", async () => {
    const statePath = join(temporary(), "update.json");
    const older = service({ deps: { statePath, fetch: fetcher("1.3.0") } });
    const newer = service({ deps: { statePath, now: () => NOW + 1000, fetch: fetcher("1.2.0") } });
    await newer.check();
    expect((await older.check({ force: true })).latest).toEqual(release("1.2.0"));
    expect(service({ deps: { statePath } }).status().checkedAt).toBe(new Date(NOW + 1000).toISOString());
  });

  test("orders saved prerelease skips numerically", async () => {
    const statePath = join(temporary(), "update.json");
    const older = service({ deps: { statePath, fetch: fetcher("1.2.0-rc.9") } });
    await older.check();
    const newer = service({ deps: { statePath, now: () => NOW + 1, fetch: fetcher("1.2.0-rc.10") } });
    await newer.check({ force: true });
    await newer.skip("1.2.0-rc.10");
    expect((await older.skip("1.2.0-rc.9")).skipped).toBe("1.2.0-rc.10");
  });

  test("survives a missing home directory without persisting", async () => {
    const home = vi.fn(() => { throw new Error("No home directory."); });
    const updates = createUpdateService({ version: "1.0.0", entry: "/source/bin.js", argv: [], cwd: "/work/app",
      deps: { homedir: home, fetch: fetcher(), now: () => NOW, realpath: () => null, env: {} } });
    expect(home).toHaveBeenCalledOnce();
    expect((await updates.check()).latest).toEqual(release());
    expect((await updates.skip("1.1.0")).skipped).toBe("1.1.0");
    await updates.close();
  });

  test("uses the configured registry base with its trailing slash removed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url) === SITE
      ? Response.json([]) : Response.json({ version: "1.2.0" }));
    const updates = service({ deps: { fetch, env: { npm_config_registry: "https://registry.example/npm/" } } });
    expect((await updates.check()).latest?.version).toBe("1.2.0");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://registry.example/npm/leglas/latest", SITE]);
  });
});

describe("installer ownership and change events", () => {
  test("notifies checks, results, errors and skips only when they change", async () => {
    const fetch = fetcher();
    const updates = service({ deps: { fetch } });
    const seen: UpdateStatus[] = [];
    updates.onChange(() => seen.push(updates.status()));
    await updates.check();
    expect(seen.map((status) => [status.phase.status, status.latest?.version ?? null, status.checkedAt])).toEqual([
      ["checking", null, null], ["checking", "1.1.0", new Date(NOW).toISOString()], ["idle", "1.1.0", new Date(NOW).toISOString()],
    ]);
    await updates.check();
    expect(seen).toHaveLength(3);
    await updates.skip("1.1.0");
    expect(seen.at(-1)?.skipped).toBe("1.1.0");
    expect(seen).toHaveLength(4);
    await updates.skip("1.1.0");
    expect(seen).toHaveLength(4);
    fetch.mockRejectedValue(new Error("offline"));
    await updates.check({ force: true });
    expect(seen.slice(-3).map((status) => [status.phase.status, status.checkError])).toEqual([
      ["checking", null], ["checking", "Could not reach npm."], ["idle", "Could not reach npm."],
    ]);
    fetch.mockImplementation(async (url) => String(url) === REGISTRY ? Response.json({ version: "1.2.0" }) : Response.json([]));
    await updates.check({ force: true });
    expect(seen.at(-1)).toMatchObject({ latest: { version: "1.2.0" }, skipped: null, checkError: null });
  });

  test("waits for a change that began during installation, then notifies the restart", async () => {
    vi.useFakeTimers();
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    let busy = false;
    updates.onBusy(() => busy);
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    const phases: string[] = [];
    updates.onChange(() => phases.push(updates.status().phase.status));
    await updates.update();
    await vi.advanceTimersByTimeAsync(0);
    busy = true;
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.status().phase).toEqual({ status: "waiting", version: "1.1.0" });
    await expect(updates.update()).rejects.toThrow("An update is already running.");
    await updates.check({ force: true });
    expect(updates.status().phase.status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(restart).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
    expect(phases).toEqual(["installing", "waiting", "restarting"]);
  });

  test.each(["linux", "win32"] as const)("close kills the whole %s installer tree and awaits its close", async (platform) => {
    const { spawn, child } = spawned();
    const kill = vi.fn<typeof process.kill>(() => true);
    const updates = service({ cached: true, deps: { spawn, kill, platform } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    let closed = false;
    const closing = updates.close();
    void closing.then(() => { closed = true; });
    expect(updates.close()).toBe(closing);
    await Promise.resolve();
    expect(closed).toBe(false);
    if (platform === "linux") expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, "SIGKILL");
    else expect(spawn).toHaveBeenLastCalledWith("taskkill", ["/pid", "12345", "/T", "/F"], { stdio: "ignore", shell: false });
    child.emit("close", null);
    await closing;
    await nextTurn();
    expect(closed).toBe(true);
    expect(restart).not.toHaveBeenCalled();
  });

  test("the Windows deadline uses taskkill and retains the child until it is gone", async () => {
    vi.useFakeTimers();
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn, platform: "win32" } });
    updates.onRestart(async () => {});
    await updates.update();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(spawn).toHaveBeenLastCalledWith("taskkill", ["/pid", "12345", "/T", "/F"], { stdio: "ignore", shell: false });
    expect(updates.status().phase.status).toBe("failed");
    await expect(updates.update()).rejects.toThrow("An update is already running.");
    let closed = false;
    const closing = updates.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    child.emit("close", null);
    await closing;
    expect(closed).toBe(true);
  });

  test("close cancels an install queued for the next turn", async () => {
    const { spawn } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await updates.close();
    await nextTurn();
    expect(spawn).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  test("close cancels the waiting timer without handing off", async () => {
    vi.useFakeTimers();
    const updates = service({ cached: true, entry: "/cache/_npx/hash/node_modules/leglas/dist/bin.js" });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    updates.onBusy(() => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.status().phase.status).toBe("waiting");
    await updates.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(restart).not.toHaveBeenCalled();
  });

  test("a handoff can close its own service without awaiting itself", async () => {
    const updates = service({ cached: true, entry: "/cache/_npx/hash/node_modules/leglas/dist/bin.js" });
    const restart = vi.fn(async () => { await updates.close(); });
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    expect(restart).toHaveResolved();
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ file: "npx" }));
  });

  test("waits for final stdout after exit and notifies the failure", async () => {
    const { spawn, child } = spawned();
    const updates = service({ cached: true, deps: { spawn } });
    updates.onRestart(async () => {});
    const phases: string[] = [];
    updates.onChange(() => phases.push(updates.status().phase.status));
    await updates.update();
    await nextTurn();
    child.emit("exit", 1);
    expect(updates.status().phase.status).toBe("installing");
    child.stdout.write("ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/leglas: Not Found\n");
    child.emit("close", 1);
    await nextTurn();
    expect(updates.status().phase).toMatchObject({ status: "failed", reason: expect.stringContaining("ERR_PNPM_FETCH_404") });
    expect(phases).toEqual(["installing", "failed"]);
  });

  test("uses the server's default port before setPort is called", async () => {
    const updates = service({ cached: true, entry: "/cache/_npx/hash/node_modules/leglas/dist/bin.js" });
    const restart = vi.fn(async () => {});
    updates.onRestart(restart);
    await updates.update();
    await nextTurn();
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ args: ["-y", "leglas@1.1.0", "--port", String(DEFAULT_PORT), "--no-open"] }));
  });
});
