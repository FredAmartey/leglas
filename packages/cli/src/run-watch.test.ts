import { mkdtempSync, readFileSync } from "node:fs";
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

const until = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((tick) => setTimeout(tick, 20));
  }
};

describe("runWatch", () => {
  test("refuses to start with no template anywhere", async () => {
    const d = deps();
    const outcome = await runWatch({ run: undefined, port: undefined, cwd: cwd() }, d);

    expect(outcome.exitCode).toBe(1);
    expect(d.lines.join("\n")).toContain("--run");
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
