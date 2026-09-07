import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UpdateService, UpdateStatus } from "@leglas/server";
import { run, skipStartupCheck } from "./run.js";

const server = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(async () => {}) }));

vi.mock("@leglas/server", async (original) => {
  const actual = await original<typeof import("@leglas/server")>();
  return {
    ...actual,
    loadConfig: async () => ({ config: null, errors: [], path: null }),
    readLocalPreviews: async () => ({ previews: [], errors: [] }),
    startServer: server.start,
  };
});

const status: UpdateStatus = {
  version: "1.0.0",
  install: { kind: "npx", manager: "npm", command: "npx leglas@latest" },
  latest: { version: "1.1.0", title: null, url: "https://leglas.vercel.app/changelog/#v1.1.0" },
  checkedAt: null,
  checkError: null,
  skipped: null,
  available: true,
  phase: { status: "idle" },
  busy: false,
};

function fakeUpdates() {
  return {
    status: () => status,
    check: vi.fn(async () => status),
    skip: vi.fn(async () => status),
    update: vi.fn(async () => status),
    notice: vi.fn<() => string | null>(() => "An update is available."),
    onRestart: vi.fn(),
    onBusy: vi.fn(),
  } satisfies UpdateService;
}

beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("LEGLAS_NO_UPDATE_CHECK", "");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ reachable: true })));
  server.start.mockResolvedValue({ url: "http://localhost:4105", port: 4105, close: server.close });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const options = { cwd: "/work/app", open: true, json: false, port: undefined, userPort: undefined, configPath: undefined };

describe("skipStartupCheck", () => {
  test.each([undefined, "", "false"])("CI=%s permits the check", (CI) => {
    expect(skipStartupCheck(CI === undefined ? {} : { CI })).toBe(false);
  });
  test.each(["true", "1", "0", "FALSE"])("CI=%s skips the check", (CI) => {
    expect(skipStartupCheck({ CI })).toBe(true);
  });
  test.each([undefined, "", "0"])("LEGLAS_NO_UPDATE_CHECK=%s permits the check", (value) => {
    expect(skipStartupCheck(value === undefined ? {} : { LEGLAS_NO_UPDATE_CHECK: value })).toBe(false);
  });
  test.each(["1", "true", "false"])("LEGLAS_NO_UPDATE_CHECK=%s skips the check", (value) => {
    expect(skipStartupCheck({ LEGLAS_NO_UPDATE_CHECK: value })).toBe(true);
  });
});

describe("startup update check without a listener", () => {
  test("prints the notice after the startup block and browser open, passing the service to the server", async () => {
    const output: string[] = [];
    const updates = fakeUpdates();
    await run(options, { updates, log: (line) => { output.push(line); }, open: async () => { output.push("opened"); } });
    await Promise.resolve();
    expect(output.at(-1)).toBe("An update is available.");
    expect(output.indexOf("opened")).toBe(output.length - 2);
    expect(output[0]).toBe("Leglas   http://localhost:4105/leglas");
    expect(server.start).toHaveBeenCalledWith(expect.objectContaining({ updates }));
  });

  test("returns without waiting for npm", async () => {
    const updates = fakeUpdates();
    let finish!: (value: UpdateStatus) => void;
    updates.check.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const log = vi.fn();
    const result = await run(options, { updates, log, open: async () => {} });
    expect(result.exitCode).toBe(0);
    expect(updates.notice).not.toHaveBeenCalled();
    finish(status);
    await Promise.resolve();
    expect(log).toHaveBeenLastCalledWith("An update is available.");
  });

  test("JSON output remains one envelope with no startup check", async () => {
    const updates = fakeUpdates();
    const log = vi.fn();
    await run({ ...options, json: true }, { updates, log, open: async () => {} });
    expect(updates.check).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ ok: true });
  });

  test("a null notice adds no output", async () => {
    const updates = fakeUpdates();
    updates.notice.mockReturnValue(null);
    const log = vi.fn();
    await run(options, { updates, log, open: async () => {} });
    await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(4);
  });

  test.each(["CI", "LEGLAS_NO_UPDATE_CHECK"])("%s suppresses the startup check", async (name) => {
    vi.stubEnv(name, "1");
    const updates = fakeUpdates();
    await run(options, { updates, log: vi.fn(), open: async () => {} });
    expect(updates.check).not.toHaveBeenCalled();
  });
});
