import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  KNOWN_AGENTS,
  activityFrom,
  detectAgents,
  readAgentChoice,
  saveAgentChoice,
} from "./agents.js";

describe("KNOWN_AGENTS", () => {
  test("builds the verified argv for each vendor without a cwd flag", () => {
    expect(KNOWN_AGENTS.claude.args("make it warmer")).toEqual([
      "-p",
      "make it warmer",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(KNOWN_AGENTS.codex.args("make it warmer")).toEqual([
      "exec",
      "--json",
      "-s",
      "workspace-write",
      "make it warmer",
    ]);
    expect(KNOWN_AGENTS.cursor.args("make it warmer")).toEqual([
      "-p",
      "make it warmer",
      "--output-format",
      "stream-json",
    ]);
  });
});

test("detectAgents probes the adapter binaries through the injected lookup", async () => {
  const lookedUp: string[] = [];
  const agents = await detectAgents(async (binary) => {
    lookedUp.push(binary);
    return binary !== "cursor-agent";
  });

  expect(lookedUp).toEqual(["claude", "codex", "cursor-agent"]);
  expect(agents).toEqual([
    { id: "claude", name: "Claude", available: true },
    { id: "codex", name: "Codex", available: true },
    { id: "cursor", name: "Cursor", available: false },
  ]);
});

describe("activityFrom", () => {
  test("reads Claude tool-use events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "src/Hero.tsx" },
          },
        ],
      },
    });

    expect(activityFrom("claude", line)).toBe("editing src/Hero.tsx");
  });

  test("reads the Codex file-change item shape emitted by codex exec --json", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "src/Hero.tsx", kind: "update" }],
        status: "in_progress",
      },
    });

    expect(activityFrom("codex", line)).toBe("editing src/Hero.tsx");
  });

  test("labels Codex command items without depending on their command text", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "pwd", status: "in_progress" },
    });

    expect(activityFrom("codex", line)).toBe("running a command");
  });

  test.each(["not json", "{}", JSON.stringify({ type: "result" })])(
    "ignores unparseable or unrecognized output: %s",
    (line) => {
      expect(activityFrom("claude", line)).toBeNull();
      expect(activityFrom("codex", line)).toBeNull();
    },
  );
});

test("agent choice preserves the saved run template and unknown config fields", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-choice-"));
  mkdirSync(join(cwd, ".leglas"));
  writeFileSync(
    join(cwd, ".leglas/watch.json"),
    JSON.stringify({ run: "my-agent {prompt}", future: { enabled: true } }),
  );

  await saveAgentChoice(cwd, { agent: "codex" });

  expect(await readAgentChoice(cwd)).toEqual({ agent: "codex", run: "my-agent {prompt}" });
  expect(JSON.parse(readFileSync(join(cwd, ".leglas/watch.json"), "utf8"))).toEqual({
    run: "my-agent {prompt}",
    future: { enabled: true },
    agent: "codex",
  });
});

test("a custom choice stores its validated template for the runner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-custom-agent-"));

  await saveAgentChoice(cwd, { agent: "custom", run: "my-agent -p {prompt}" });

  expect(await readAgentChoice(cwd)).toEqual({
    agent: "custom",
    run: "my-agent -p {prompt}",
  });
});

test("an inherited object key is not accepted as a built-in agent id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-id-"));
  mkdirSync(join(cwd, ".leglas"));
  writeFileSync(join(cwd, ".leglas/watch.json"), JSON.stringify({ agent: "toString" }));

  expect(await readAgentChoice(cwd)).toEqual({ agent: null, run: null });
});
