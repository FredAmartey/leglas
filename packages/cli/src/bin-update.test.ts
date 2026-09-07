import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  realpath: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
  shutdown: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), realpathSync: mocked.realpath }));
vi.mock("@leglas/server", async (original) => ({ ...await original<typeof import("@leglas/server")>(), createUpdateService: mocked.create }));
vi.mock("./run.js", () => ({ run: mocked.run }));
vi.mock("./shutdown.js", async (original) => ({ ...await original<typeof import("./shutdown.js")>(), installShutdown: mocked.shutdown }));

const argv = process.argv;
const warningListeners = process.listeners("warning");

beforeEach(() => {
  vi.resetModules();
  mocked.realpath.mockReturnValue("/resolved/leglas/bin.js");
  mocked.create.mockReturnValue({ onRestart: vi.fn() });
  mocked.run.mockImplementation(async (_options, deps) => {
    deps.log('{"ok":true}');
    return { stop: vi.fn(async () => {}) };
  });
});
afterEach(() => {
  process.argv = argv;
  process.removeAllListeners("warning");
  for (const listener of warningListeners) process.on("warning", listener);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("CLI update wiring", () => {
  test.each([true, false])("routes service logs for JSON=%s and preserves the startup envelope", async (json) => {
    process.argv = [process.execPath, "/invoked/leglas", ...(json ? ["--json"] : []), "--no-open"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("./bin.js");
    const input = mocked.create.mock.calls[0]![0];
    input.deps.log("Updating Leglas.");
    input.deps.log("Restarting Leglas.");
    expect(input.entry).toBe("/resolved/leglas/bin.js");
    expect(stdout.mock.calls.map(([line]) => line)).toEqual(json
      ? ['{"ok":true}\n'] : ['{"ok":true}\n', "Updating Leglas.\n", "Restarting Leglas.\n"]);
    expect(stderr.mock.calls.map(([line]) => line)).toEqual(json ? ["Updating Leglas.\n", "Restarting Leglas.\n"] : []);
    expect(mocked.shutdown).toHaveBeenCalledOnce();
  });

  test("starts with the unresolved entry when realpath fails", async () => {
    process.argv = [process.execPath, "/invoked/leglas", "--no-open"];
    mocked.realpath.mockImplementation(() => { throw new Error("The cache entry is gone."); });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await import("./bin.js");
    expect(mocked.create.mock.calls[0]![0].entry).toBe(fileURLToPath(new URL("./bin.ts", import.meta.url)));
    expect(mocked.run).toHaveBeenCalledOnce();
  });
});
