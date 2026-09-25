import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { appendRequest, readRequests } from "@leglas/server";

import type { JsonValue } from "./json.js";
import { runWatch } from "./run-watch.js";

/**
 * The port the watcher is told to beat at. Nothing ever reaches it.
 *
 * Leaving this undefined meant DEFAULT_PORT, and these tests then aimed
 * watcher heartbeats at whatever is genuinely running on 4100 on the machine
 * running them: a developer's own Leglas, told a watcher had attached and then
 * gone. Binding an ephemeral port and closing it fixed that, but left every
 * test in the file making a real network call to learn nothing, which is what
 * made this the first file to time out under a loaded suite. The beat is
 * stubbed for the whole file instead, so this number is never dialled and
 * every test here is about the loop's bookkeeping rather than about HTTP.
 */
const DEAD_PORT = 4399;

const cwd = () => mkdtempSync(join(tmpdir(), "leglas-watch-"));

const input = {
  title: "Aurora",
  url: "/?v-hero=aurora",
  intent: "warmer",
  target: null,
  prompt: "make it warmer",
};

function deps() {
  const lines: string[] = [];

  return {
    lines,
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

function writeWatchConfig(root: string, config: { [key: string]: JsonValue }): void {
  mkdirSync(join(root, ".leglas"), { recursive: true });
  writeFileSync(join(root, ".leglas/watch.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** How long a wait may take before it is a hang rather than a slow machine. */
const EVENTUALLY_MS = 15_000;

/**
 * The deadline bounds a hang. It is not an assertion about latency.
 *
 * Two different tests failed here on a loaded machine, both with "condition
 * never held", both waiting on something the operating system delivers when it
 * gets to it: a filesystem watch event, a reachability probe. A suite that
 * reports a slow machine as a defect teaches people to rerun until it passes,
 * which is how a real failure gets waved through.
 *
 * Fifteen seconds costs nothing on every run where the condition holds.
 */
const until = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + EVENTUALLY_MS;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((tick) => setTimeout(tick, 20));
  }
};

async function startAndStop(root: string, run?: string): Promise<string[]> {
  const controller = new AbortController();
  const d = deps();
  let outcome: Awaited<ReturnType<typeof runWatch>> | null = null;

  const running = runWatch({ run, port: DEAD_PORT, cwd: root, signal: controller.signal }, d).then(
    (result) => {
      outcome = result;

      return result;
    },
  );

  await until(() => outcome !== null || d.lines.some((line) => line.startsWith("Watching ")));
  expect(outcome).toBeNull();
  controller.abort();
  expect((await running).exitCode).toBe(0);

  return d.lines;
}

describe("runWatch", () => {
  // The case the loop is written for: nothing is listening. Refusing at once
  // is what a closed port does, without the socket, the abort timer, or the
  // chance that the port has quietly become another worker's server. Tests
  // that care what the server said stub their own.
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("nothing is listening");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the first pickup waits for the server to learn a watcher exists", async () => {
    const root = cwd();
    await appendRequest(root, input);

    // The stub plays a slow server: while the first heartbeat is still in
    // flight, the queue must not have been touched. The unawaited version of
    // this beat let watch pick the request up inside exactly this window,
    // while the embedded runner could still believe it was alone.
    let statusDuringFirstBeat: string | null = null;
    vi.stubGlobal("fetch", async () => {
      if (statusDuringFirstBeat === null) {
        await new Promise((settle) => setTimeout(settle, 60));
        statusDuringFirstBeat = (await readRequests(root))[0]?.status ?? "gone";
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new AbortController();

    const running = runWatch(
      {
        run: 'node -e "process.exit(0)" {prompt}',
        port: DEAD_PORT,
        cwd: root,
        signal: controller.signal,
      },
      deps(),
    );

    await until(async () => (await readRequests(root)).length === 0);
    controller.abort();
    await running;

    expect(statusDuringFirstBeat).toBe("queued");
  });

  test("refuses to start with no template anywhere", async () => {
    const d = deps();
    const outcome = await runWatch({ run: undefined, port: DEAD_PORT, cwd: cwd() }, d);

    expect(outcome.exitCode).toBe(1);
    expect(d.lines.join("\n")).toContain("pick an agent in the interface");
    expect(d.lines.join("\n")).toContain("--run");
  });

  test("a --run flag beats both the saved template and agent choice", async () => {
    const root = cwd();
    writeWatchConfig(root, { run: "saved-agent {prompt}", agent: "claude" });

    const lines = await startAndStop(root, "flag-agent {prompt}");

    expect(lines).toContain("Watching for change requests. Each one runs: flag-agent {prompt}");
    expect(lines.some((line) => line.startsWith("Using Claude"))).toBe(false);
  });

  test("a saved template beats the saved agent choice", async () => {
    const root = cwd();
    writeWatchConfig(root, { run: "saved-agent {prompt}", agent: "claude" });

    const lines = await startAndStop(root);

    expect(lines).toContain("Watching for change requests. Each one runs: saved-agent {prompt}");
    expect(lines.some((line) => line.startsWith("Using Claude"))).toBe(false);
  });

  test.each([
    ["claude", "Claude", "claude -p {prompt} --permission-mode acceptEdits"],
    [
      "codex",
      "Codex",
      "codex exec -c sandbox_workspace_write.network_access=true -s workspace-write --skip-git-repo-check {prompt}",
    ],
    ["cursor", "Cursor", "cursor-agent -p {prompt} --trust"],
  ])("synthesizes the terminal template for %s", async (agent, name, command) => {
    const root = cwd();
    writeWatchConfig(root, { agent });

    const lines = await startAndStop(root);

    expect(lines).toContain(`Using ${name}, chosen in the interface.`);
    expect(lines).toContain(`Watching for change requests. Each one runs: ${command}`);
  });

  test.each([
    ["claude", "high", "claude -p {prompt} --permission-mode acceptEdits --effort high"],
    [
      "codex",
      "xhigh",
      "codex exec -c sandbox_workspace_write.network_access=true -c model_reasoning_effort=xhigh -s workspace-write --skip-git-repo-check {prompt}",
    ],
  ])("includes the saved effort in the %s terminal template", async (agent, effort, command) => {
    const root = cwd();
    writeWatchConfig(root, { agent, efforts: { [agent]: effort } });

    const lines = await startAndStop(root);

    expect(lines).toContain(`Watching for change requests. Each one runs: ${command}`);
  });

  test("does not write a synthesized command back to the shared config", async () => {
    const root = cwd();
    const config = { agent: "codex", future: { enabled: true } };
    writeWatchConfig(root, config);

    await startAndStop(root);

    expect(JSON.parse(readFileSync(join(root, ".leglas/watch.json"), "utf8"))).toEqual(config);
  });

  test("remembering a --run template preserves the saved agent choice", async () => {
    const root = cwd();
    writeWatchConfig(root, { agent: "claude" });

    await startAndStop(root, "flag-agent {prompt}");

    expect(JSON.parse(readFileSync(join(root, ".leglas/watch.json"), "utf8"))).toEqual({
      agent: "claude",
      run: "flag-agent {prompt}",
    });
  });

  test("stopping mid-run waits for the request's bookkeeping", async () => {
    const root = cwd();
    await appendRequest(root, input);

    // An agent slow enough that the stop lands while it is still running, and
    // successful, so the request must end up removed, not stranded.
    const controller = new AbortController();

    const running = runWatch(
      {
        run: `node -e "setTimeout(() => process.exit(0), 400)" {prompt}`,
        port: DEAD_PORT,
        cwd: root,
        signal: controller.signal,
      },
      deps(),
    );

    await until(async () => (await readRequests(root))[0]?.status === "picked-up");
    controller.abort();
    const outcome = await running;

    // The watcher's promise settling is its claim that the books are closed:
    // the agent exited 0, so the request must already be gone.
    expect(outcome.exitCode).toBe(0);
    expect(await readRequests(root)).toEqual([]);
  });

  // docs/cli.md, "Watch as JSON": one object per line, each with an event.
  test("under --json every line is an event, in the order things happened", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const [queued] = await readRequests(root);
    const controller = new AbortController();
    const d = deps();
    const run = 'node -e "process.exit(0)" {prompt}';

    const running = runWatch(
      { run, port: DEAD_PORT, cwd: root, json: true, signal: controller.signal },
      d,
    );

    await until(async () => (await readRequests(root)).length === 0);
    controller.abort();
    await running;

    expect(d.lines.map((line) => JSON.parse(line))).toEqual([
      { event: "watching", command: run, agent: null },
      { event: "started", id: queued?.id, title: "Aurora", intent: "warmer", target: null },
      { event: "done", id: queued?.id, title: "Aurora" },
      { event: "stopped" },
    ]);
  });

  test("under --json a failed request is a failed event carrying the queue's verdict", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const controller = new AbortController();
    const d = deps();

    const running = runWatch(
      {
        run: 'node -e "process.exit(3)" {prompt}',
        port: DEAD_PORT,
        cwd: root,
        json: true,
        signal: controller.signal,
      },
      d,
    );

    await until(() => d.lines.some((line) => line.includes('"event":"failed"')));
    controller.abort();
    await running;

    const [written] = await readRequests(root);
    const failed = d.lines.map((line) => JSON.parse(line)).find((line) => line.event === "failed");
    // An agent that ran and exited nonzero, as FailureCode names it.
    expect(written?.failure?.code).toBe("agent-error");
    expect(failed).toEqual({
      event: "failed",
      id: written?.id,
      title: "Aurora",
      code: "agent-error",
      reason: written?.failure?.message,
    });
  });

  test("under --json a watch that cannot start prints the usual failure envelope", async () => {
    const d = deps();
    const outcome = await runWatch({ run: undefined, port: DEAD_PORT, cwd: cwd(), json: true }, d);

    expect(outcome.exitCode).toBe(1);
    expect(d.lines.map((line) => JSON.parse(line))).toEqual([
      { ok: false, error: expect.stringContaining("pick an agent in the interface") },
    ]);
  });

  test("a command that cannot spawn is written down as failed and unretried", async () => {
    const root = cwd();
    await appendRequest(root, input);

    const controller = new AbortController();
    const d = deps();

    const running = runWatch(
      {
        run: "leglas-watch-test-no-such-program {prompt}",
        port: DEAD_PORT,
        cwd: root,
        signal: controller.signal,
      },
      d,
    );

    await until(() => d.lines.some((line) => line.includes("failed")));
    controller.abort();
    await running;

    const remaining = await readRequests(root);
    expect(remaining).toHaveLength(1);
    // Left in the queue, but as a request that ended rather than one still in
    // somebody's hands: the interface reads this file, and "picked-up" there
    // said an agent was working on it for as long as the file existed.
    expect(remaining[0]?.status).toBe("failed");
    expect(remaining[0]?.failure?.code).toBe("missing-agent");
    expect(d.lines.join("\n")).toContain("not retried");
  });

  // --help: the --run command is "Remembered after first use".
  test("remembers the template for the next flagless run", async () => {
    const root = cwd();
    await startAndStop(root, "node {prompt}");

    const lines = await startAndStop(root);

    expect(lines).toContain("Watching for change requests. Each one runs: node {prompt}");
  });
});

describe("leglas watch --json, as a process", () => {
  // What only a real process shows: stdout carries the events and nothing
  // else, because the agent's own output goes to stderr instead. Needs the
  // build, which `pnpm test` runs first.
  test("stdout is JSON lines while the agent's output goes to stderr", async () => {
    const root = cwd();
    await appendRequest(root, input);
    let stdout = "";
    let stderr = "";
    let exited: number | null | undefined;

    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "../dist/bin.js"),
        "watch",
        "--json",
        "--port",
        String(DEAD_PORT),
        "--run",
        `node -e "console.log('agent chatter')" {prompt}`,
      ],
      { cwd: root },
    );

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const closed = new Promise<void>((settle) =>
      child.on("close", (code) => {
        exited = code;
        settle();
      }),
    );

    await until(() => stdout.includes('"event":"done"') || exited !== undefined);
    child.kill("SIGTERM");
    await closed;

    // A missing build fails here, with node's "Cannot find module" as the message.
    expect(exited, stderr).toBe(0);

    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);

    expect(events).toEqual(["watching", "started", "done", "stopped"]);
    expect(stderr).toContain("agent chatter");
  });
});

describe("stopping before the loop is listening", () => {
  test("a signal that fired during startup still stops the watcher", async () => {
    // Everything before the loop is awaited work, and a caller can abort
    // inside that window: the tests here wait for the template write, so a
    // stop can land after that file appears and before the loop listens. A
    // listener added to an already-aborted signal is never called, so this
    // used to leave the watcher running with nobody to stop it and the caller
    // waiting on a promise that never settled.
    const root = cwd();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runWatch(
      { run: "node {prompt}", port: DEAD_PORT, cwd: root, signal: controller.signal },
      deps(),
    );

    expect(outcome.exitCode).toBe(0);
  });
});
