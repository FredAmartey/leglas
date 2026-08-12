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

  test("builds readable terminal argv for each vendor", () => {
    expect(KNOWN_AGENTS.claude.terminalArgs("make it warmer")).toEqual([
      "-p",
      "make it warmer",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(KNOWN_AGENTS.codex.terminalArgs("make it warmer")).toEqual([
      "exec",
      "-s",
      "workspace-write",
      "make it warmer",
    ]);
    expect(KNOWN_AGENTS.cursor.terminalArgs("make it warmer")).toEqual([
      "-p",
      "make it warmer",
    ]);
  });
});

test("detectAgents probes binaries and logins through the injected hooks", async () => {
  const lookedUp: string[] = [];
  const probed: string[] = [];
  const agents = await detectAgents(
    async (binary) => {
      lookedUp.push(binary);
      return binary !== "cursor-agent";
    },
    async (binary, args) => {
      probed.push(`${binary} ${args.join(" ")}`);
      if (binary === "claude") return { code: 0, stdout: '{"loggedIn": true}' };
      return { code: 1, stdout: "Not logged in" };
    },
  );

  expect(lookedUp).toEqual(["claude", "codex", "cursor-agent"]);
  // No probe for the missing binary: there is nothing to ask.
  expect(probed).toEqual(["claude auth status", "codex login status"]);
  expect(agents).toEqual([
    { id: "claude", name: "Claude", available: true, auth: "ok" },
    { id: "codex", name: "Codex", available: true, auth: "signed-out" },
    { id: "cursor", name: "Cursor", available: false, auth: "unknown" },
  ]);
});

test("an unreadable or failed probe reads as unknown, never as signed out", async () => {
  const agents = await detectAgents(
    async () => true,
    async (binary) =>
      binary === "claude" ? { code: 0, stdout: "not json at all" } : null,
  );

  expect(agents.map((agent) => agent.auth)).toEqual(["unknown", "unknown", "unknown"]);
});

test("each vendor's verdict reads its own CLI honestly", () => {
  expect(KNOWN_AGENTS.claude.authVerdict({ code: 0, stdout: '{"loggedIn": false}' })).toBe(
    "signed-out",
  );
  expect(KNOWN_AGENTS.codex.authVerdict({ code: 0, stdout: "Logged in using ChatGPT" })).toBe("ok");
  expect(KNOWN_AGENTS.cursor.authVerdict({ code: 0, stdout: "Logged in as fred" })).toBe("ok");
  expect(KNOWN_AGENTS.cursor.authVerdict({ code: 0, stdout: "Please sign in" })).toBe("signed-out");
  expect(KNOWN_AGENTS.cursor.authVerdict({ code: 0, stdout: "cursor-agent 1.2.3" })).toBe(
    "unknown",
  );
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

  test("shows the command a Codex item is running, unwrapped from its shell", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "bash -lc 'npm test'",
        status: "in_progress",
      },
    });

    expect(activityFrom("codex", line)).toBe("running npm test");
  });

  test("shows the command Claude's Bash tool is running", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "grep -r Hero src" } },
        ],
      },
    });

    expect(activityFrom("claude", line)).toBe("running grep -r Hero src");
  });

  test.each([
    [["bash", "-lc", "pnpm build"], "running pnpm build"],
    ["  git  status\nsecond line ignored", "running git status"],
    [`sh -c "${"x".repeat(60)}"`, `running ${"x".repeat(47)}…`],
    [42, "running a command"],
    ["", "running a command"],
  ])("cleans command text for the status line: %j", (command, expected) => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command, status: "in_progress" },
    });

    expect(activityFrom("codex", line)).toBe(expected);
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
