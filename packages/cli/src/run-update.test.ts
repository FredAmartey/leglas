import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UpdateService, UpdateStatus, startServer } from "@leglas/server";
import { runWithServices, skipStartupCheck } from "./run.js";

const server = { start: vi.fn<typeof startServer>(), close: vi.fn(async () => {}) };

/** A project with no config and nothing registered, so the update check is all that varies. */
const run = (
  options: Parameters<typeof runWithServices>[0],
  deps: Parameters<typeof runWithServices>[1],
) => runWithServices(options, deps, { startServer: server.start });

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
    onChange: vi.fn(),
    setPort: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies UpdateService;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CI", "");
  vi.stubEnv("LEGLAS_NO_UPDATE_CHECK", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ reachable: true })),
  );
  server.start.mockResolvedValue({ url: "http://localhost:4105", port: 4105, close: server.close });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const options = {
  cwd: mkdtempSync(join(tmpdir(), "leglas-update-")),
  open: true,
  json: false,
  port: undefined,
  userPort: undefined,
  configPath: undefined,
};

describe("skipStartupCheck", () => {
  // CI follows ci-info: only the literal false opts out of a nonempty CI value.
  test.each([
    [{}, false],
    [{ CI: "" }, false],
    [{ CI: "false" }, false],
    [{ CI: "true" }, true],
    [{ CI: "1" }, true],
    [{ CI: "0" }, true],
    [{ CI: "FALSE" }, true],
    [{ LEGLAS_NO_UPDATE_CHECK: "" }, false],
    [{ LEGLAS_NO_UPDATE_CHECK: "0" }, false],
    [{ LEGLAS_NO_UPDATE_CHECK: "false" }, false],
    [{ LEGLAS_NO_UPDATE_CHECK: "1" }, true],
    [{ LEGLAS_NO_UPDATE_CHECK: "true" }, true],
    [{ LEGLAS_NO_UPDATE_CHECK: "FALSE" }, true],
  ])("%j skips the check: %s", (env, skips) => {
    expect(skipStartupCheck(env)).toBe(skips);
  });
});

describe("startup update check without a listener", () => {
  test("forwards the port and update service it is given to the server", async () => {
    const updates = fakeUpdates();

    const present = await run(
      { ...options, port: 0 },
      { updates, log: vi.fn(), open: async () => {} },
    );

    const given = server.start.mock.calls[0]![0];
    expect(given.port).toBe(0);
    expect(given.updates).toBe(updates);
    await present.stop();
  });

  test("checks again hourly without printing another notice, and stops checking on stop", async () => {
    const updates = fakeUpdates();
    const log = vi.fn();
    const result = await run(options, { updates, log, open: async () => {} });
    await Promise.resolve();
    expect(updates.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(updates.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.check).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([line]) => line === "An update is available.")).toHaveLength(1);
    await result.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(updates.check).toHaveBeenCalledTimes(2);
  });

  test("a startup check finishing after stop prints nothing", async () => {
    const updates = fakeUpdates();
    let finish!: (value: UpdateStatus) => void;
    updates.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const log = vi.fn();
    const result = await run(options, { updates, log, open: async () => {} });
    await result.stop();
    finish(status);
    await Promise.resolve();
    expect(log).not.toHaveBeenCalledWith("An update is available.");
  });
  test("returns without waiting for npm", async () => {
    const updates = fakeUpdates();
    let finish!: (value: UpdateStatus) => void;
    updates.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const log = vi.fn();
    const result = await run(options, { updates, log, open: async () => {} });
    expect(result.exitCode).toBe(0);
    expect(updates.notice).not.toHaveBeenCalled();
    finish(status);
    await Promise.resolve();
    expect(log).toHaveBeenLastCalledWith("An update is available.");
  });

  test.each(["CI", "LEGLAS_NO_UPDATE_CHECK"])("%s suppresses the startup check", async (name) => {
    vi.stubEnv(name, "1");
    const updates = fakeUpdates();
    await run(options, { updates, log: vi.fn(), open: async () => {} });
    expect(updates.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(updates.check).not.toHaveBeenCalled();
  });
});
