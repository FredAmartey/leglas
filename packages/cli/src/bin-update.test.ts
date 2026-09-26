import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import type { createUpdateService, UpdateService } from "@leglas/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startViewer } from "./bin-start.js";
import type { run } from "./run.js";
import type { installShutdown } from "./shutdown.js";

const service = {
  status: vi.fn<UpdateService["status"]>(),
  check: vi.fn<UpdateService["check"]>(),
  skip: vi.fn<UpdateService["skip"]>(),
  update: vi.fn<UpdateService["update"]>(),
  notice: vi.fn<UpdateService["notice"]>(),
  onRestart: vi.fn<UpdateService["onRestart"]>(),
  onBusy: vi.fn<UpdateService["onBusy"]>(),
  onChange: vi.fn<UpdateService["onChange"]>(),
  setPort: vi.fn<UpdateService["setPort"]>(),
  close: vi.fn(async () => {}),
} satisfies UpdateService;

const mocked = {
  realpath: vi.fn<(path: string) => string>(),
  create: vi.fn<typeof createUpdateService>(),
  run: vi.fn<typeof run>(),
  shutdown: vi.fn<typeof installShutdown>(),
};

const argv = process.argv;

beforeEach(() => {
  mocked.realpath.mockReturnValue("/resolved/leglas/bin.js");
  mocked.create.mockReturnValue(service);
  mocked.run.mockImplementation(async (_options, deps) => {
    deps.log('{"ok":true}');

    return {
      exitCode: 0,
      url: "http://localhost:4105/leglas",
      devServer: "http://localhost:3000",
      previewCount: 0,
      stop: vi.fn(async () => {}),
    };
  });
});

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const entry = fileURLToPath(new URL("./bin.ts", import.meta.url));

function start(json: boolean) {
  return startViewer(
    {
      cwd: process.cwd(),
      json,
      open: false,
      port: undefined,
      userPort: undefined,
      configPath: undefined,
    },
    {
      entry,
      version: "1.0.0",
      open: async () => {},
      realpath: mocked.realpath,
      createUpdateService: mocked.create,
      run: mocked.run,
      installShutdown: mocked.shutdown,
    },
  );
}

describe("CLI update wiring", () => {
  test.each([true, false])(
    "routes service logs for JSON=%s and preserves the startup envelope",
    async (json) => {
      process.argv = [
        process.execPath,
        "/invoked/leglas",
        ...(json ? ["--json"] : []),
        "--no-open",
      ];
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await start(json);
      const input = mocked.create.mock.calls[0]![0];
      input.deps?.log?.("Updating Leglas.");
      input.deps?.log?.("Restarting Leglas.");
      expect(input.entry).toBe("/resolved/leglas/bin.js");
      expect(stdout.mock.calls.map(([line]) => line)).toEqual(
        json ? ['{"ok":true}\n'] : ['{"ok":true}\n', "Updating Leglas.\n", "Restarting Leglas.\n"],
      );
      expect(stderr.mock.calls.map(([line]) => line)).toEqual(
        json ? ["Updating Leglas.\n", "Restarting Leglas.\n"] : [],
      );
    },
  );

  // After a restart hands off, a Ctrl-C belongs to the child, so the ordinary
  // shutdown must not stop or exit again.
  test("after a restart hands off, a shutdown signal goes to the child alone", async () => {
    process.argv = [process.execPath, "/invoked/leglas", "--no-open"];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const target = new EventEmitter();
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const exit = vi.fn<(code: number) => void>();

    await startViewer(
      {
        cwd: process.cwd(),
        json: false,
        open: false,
        port: undefined,
        userPort: undefined,
        configPath: undefined,
      },
      {
        entry,
        version: "1.0.0",
        open: async () => {},
        realpath: mocked.realpath,
        createUpdateService: mocked.create,
        run: mocked.run,
        handoff: { spawn: () => child, exit, target },
      },
    );

    const { stop } = await mocked.run.mock.results[0]!.value;
    const restart = service.onRestart.mock.calls[0]![0];
    await restart({ file: "npx", args: ["-y", "leglas@1.1.0"], shell: false });

    // One signal reaches both the handoff and the ordinary shutdown.
    target.emit("SIGINT");
    await Promise.resolve();

    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    child.emit("exit", 0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  test("starts with the unresolved entry when realpath fails", async () => {
    process.argv = [process.execPath, "/invoked/leglas", "--no-open"];
    mocked.realpath.mockImplementation(() => {
      throw new Error("The cache entry is gone.");
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await start(false);
    expect(mocked.create.mock.calls[0]![0].entry).toBe(entry);
    expect(mocked.run).toHaveBeenCalledOnce();
  });
});
