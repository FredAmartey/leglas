import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { appendRequest, readRequests } from "@leglas/server";

import { runWatch } from "./run-watch.js";

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
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
}

function writeWatchConfig(root: string, config: Record<string, unknown>): void {
  mkdirSync(join(root, ".leglas"), { recursive: true });
  writeFileSync(join(root, ".leglas/watch.json"), `${JSON.stringify(config, null, 2)}\n`);
}

const until = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((tick) => setTimeout(tick, 20));
  }
};

async function startAndStop(root: string, run?: string): Promise<string[]> {
  const controller = new AbortController();
  const d = deps();
  let outcome: Awaited<ReturnType<typeof runWatch>> | null = null;
  const running = runWatch(
    { run, port: undefined, cwd: root, signal: controller.signal },
    d,
  ).then((result) => {
    outcome = result;
    return result;
  });

  await until(() => outcome !== null || d.lines.some((line) => line.startsWith("Watching ")));
  expect(outcome).toBeNull();
  controller.abort();
  expect((await running).exitCode).toBe(0);
  return d.lines;
}

describe("runWatch", () => {
  test("refuses to start with no template anywhere", async () => {
    const d = deps();
    const outcome = await runWatch({ run: undefined, port: undefined, cwd: cwd() }, d);

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
    ["codex", "Codex", "codex exec -s workspace-write {prompt}"],
    ["cursor", "Cursor", "cursor-agent -p {prompt}"],
  ])("synthesizes the terminal template for %s", async (agent, name, command) => {
    const root = cwd();
    writeWatchConfig(root, { agent });

    const lines = await startAndStop(root);

    expect(lines).toContain(`Using ${name}, chosen in the interface.`);
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
        port: undefined,
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

  test("a command that cannot spawn leaves the request picked-up and unretried", async () => {
    const root = cwd();
    await appendRequest(root, input);

    const controller = new AbortController();
    const d = deps();
    const running = runWatch(
      { run: "leglas-watch-test-no-such-program {prompt}", port: undefined, cwd: root, signal: controller.signal },
      d,
    );

    await until(() => d.lines.some((line) => line.includes("failed")));
    controller.abort();
    await running;

    const remaining = await readRequests(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe("picked-up");
    expect(d.lines.join("\n")).toContain("not retried");
  });

  test("remembers the template for the next flagless run", async () => {
    const root = cwd();
    const controller = new AbortController();
    const running = runWatch(
      { run: "node {prompt}", port: undefined, cwd: root, signal: controller.signal },
      deps(),
    );

    await until(() => {
      try {
        return JSON.parse(readFileSync(join(root, ".leglas/watch.json"), "utf8")).run === "node {prompt}";
      } catch {
        return false;
      }
    });
    controller.abort();
    await running;
  });
});
