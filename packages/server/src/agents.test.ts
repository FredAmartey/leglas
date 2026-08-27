import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  AGENT_EFFORTS,
  KNOWN_AGENTS,
  activityFrom,
  agentSearchPath,
  detectAgents,
  execProbe,
  readAgentChoice,
  retryFrom,
  saveAgentChoice,
  sessionFrom,
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
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
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
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "make it warmer",
    ]);
    expect(KNOWN_AGENTS.cursor.terminalArgs("make it warmer")).toEqual([
      "-p",
      "make it warmer",
    ]);
  });

  test("puts every image before the Codex prompt on cold, resumed and terminal runs", () => {
    const images = ["/project/frame.png", "/project/note-1.png"];
    for (const argv of [
      KNOWN_AGENTS.codex.args("make it warmer", null, images),
      KNOWN_AGENTS.codex.resumeArgs("th_1", "make it warmer", null, images),
      KNOWN_AGENTS.codex.terminalArgs("make it warmer", null, images),
    ]) {
      expect(argv.slice(-5)).toEqual([
        "-i",
        "/project/frame.png",
        "-i",
        "/project/note-1.png",
        "make it warmer",
      ]);
    }
    expect(KNOWN_AGENTS.claude.args("make it warmer", null, images)).not.toContain("-i");
    expect(KNOWN_AGENTS.cursor.args("make it warmer", null, images)).not.toContain("-i");
  });

  test("grants each exact Claude command as its own allowed tool", () => {
    expect(KNOWN_AGENTS.claude.allowArgs(["npx leglas show", "npx leglas add"])).toEqual([
      "--allowedTools",
      "Bash(npx leglas show *)",
      "Bash(npx leglas add *)",
    ]);
  });
});

test("codex is told it may run outside a git repository", () => {
  // codex-cli 0.147.0 refuses before it contacts a model: "Not inside a
  // trusted directory and --skip-git-repo-check was not specified." Every
  // codex argv Leglas builds has to carry the flag, or the whole vendor is
  // unusable in a project the user never put under version control.
  for (const argv of [
    KNOWN_AGENTS.codex.args("make it warmer"),
    KNOWN_AGENTS.codex.resumeArgs("th_1", "make it warmer"),
    KNOWN_AGENTS.codex.terminalArgs("make it warmer"),
  ]) {
    expect(argv).toContain("--skip-git-repo-check");
  }
  // The flag moves the repository precondition and nothing else: the sandbox
  // still confines writes to the workspace.
  expect(KNOWN_AGENTS.codex.args("make it warmer")).toContain("workspace-write");
});

test("agent defaults do not override the user's quality settings", () => {
  for (const argv of [
    KNOWN_AGENTS.codex.args("make it warmer"),
    KNOWN_AGENTS.codex.resumeArgs("th_1", "make it warmer"),
    KNOWN_AGENTS.codex.terminalArgs("make it warmer"),
  ]) {
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(argv.join(" ")).not.toMatch(/model_reasoning_effort|--model|-m /);
  }
});

test("adds an explicit effort only when the user chooses one", () => {
  expect(KNOWN_AGENTS.claude.args("make it warmer", "high")).toEqual(
    expect.arrayContaining(["--effort", "high"]),
  );
  for (const argv of [
    KNOWN_AGENTS.codex.args("make it warmer", "xhigh"),
    KNOWN_AGENTS.codex.resumeArgs("th_1", "make it warmer", "xhigh"),
    KNOWN_AGENTS.codex.terminalArgs("make it warmer", "xhigh"),
  ]) {
    expect(argv).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=xhigh"]));
  }
});

test("searches conventional user install directories beyond a service PATH", () => {
  const entries = agentSearchPath(
    { HOME: "/Users/example", PATH: "/usr/bin:/bin" },
    "darwin",
  ).split(delimiter);

  expect(entries).toEqual(
    expect.arrayContaining([
      "/usr/bin",
      "/bin",
      "/Users/example/.local/bin",
      "/Users/example/.npm-global/bin",
      "/opt/homebrew/bin",
      "/Applications/Codex.app/Contents/Resources",
    ]),
  );
  expect(new Set(entries).size).toBe(entries.length);
});

test("finds CLIs installed inside an NVM-managed Node version", () => {
  const home = mkdtempSync(join(tmpdir(), "leglas-agent-home-"));
  const bin = join(home, ".nvm", "versions", "node", "v24.7.0", "bin");
  mkdirSync(bin, { recursive: true });

  expect(agentSearchPath({ HOME: home, PATH: "/usr/bin" }).split(delimiter)).toContain(bin);
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
    { id: "claude", name: "Claude", available: true, auth: "ok", efforts: AGENT_EFFORTS },
    { id: "codex", name: "Codex", available: true, auth: "signed-out", efforts: AGENT_EFFORTS },
    { id: "cursor", name: "Cursor", available: false, auth: "unknown", efforts: [] },
  ]);
});

test("a status command whose child outlives it still answers, as unknown", async () => {
  // The shape that wedged the agents endpoint: the command exits at once, but
  // something it started holds the output pipe open, so "close" never fires.
  // Waiting on that event alone left the probe pending for the life of the
  // process and the composer's chooser never loaded again.
  const started = Date.now();
  const result = await execProbe("/bin/sh", ["-c", "sleep 30 & echo hello"], 150);

  expect(result).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("an unreadable or failed probe reads as unknown, never as signed out", async () => {
  const agents = await detectAgents(
    async () => true,
    async (binary) =>
      binary === "claude" ? { code: 0, stdout: "not json at all" } : null,
  );

  expect(agents.map((agent) => agent.auth)).toEqual(["unknown", "unknown", "unknown"]);
});

test("resume argv continues the session without trying to replace its sandbox", () => {
  expect(KNOWN_AGENTS.claude.resumeArgs("sid-1", "make it warmer")).toEqual([
    "-p",
    "--resume",
    "sid-1",
    "make it warmer",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
  ]);
  // `codex exec resume` refuses -s and inherits the session's sandbox. The
  // repository check is per invocation, so the flag is not inherited.
  expect(KNOWN_AGENTS.codex.resumeArgs("sid-2", "make it warmer")).toEqual([
    "exec",
    "resume",
    "sid-2",
    "--json",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--skip-git-repo-check",
    "make it warmer",
  ]);
});

test("sessionFrom reads each vendor's own id and nothing else", () => {
  expect(
    sessionFrom("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "abc" })),
  ).toBe("abc");
  expect(
    sessionFrom("codex", JSON.stringify({ type: "thread.started", thread_id: "th_1" })),
  ).toBe("th_1");
  // Codex ids ride only on thread.started; other events must not be read.
  expect(
    sessionFrom("codex", JSON.stringify({ type: "item.started", thread_id: "th_2" })),
  ).toBeNull();
  expect(sessionFrom("claude", "not json")).toBeNull();
  expect(sessionFrom("custom", JSON.stringify({ session_id: "abc" }))).toBeNull();
  expect(sessionFrom("cursor", JSON.stringify({ session_id: "abc" }))).toBeNull();
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

describe("retryFrom", () => {
  test("reads the api_retry event Claude prints while it backs off", () => {
    // Captured from claude stream-json against a local endpoint answering 529.
    const line = JSON.stringify({
      type: "system",
      subtype: "api_retry",
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 2045,
      error_status: 529,
      error: "overloaded",
      session_id: "s_1",
    });
    expect(retryFrom("claude", line)).toEqual({
      attempt: 3,
      max: 10,
      status: 529,
      reason: "overloaded",
    });
    // Cursor's stream-json follows Claude's shape; codex retries silently.
    expect(retryFrom("cursor", line)).not.toBeNull();
    expect(retryFrom("codex", line)).toBeNull();
  });

  test("ignores every other line, including malformed ones", () => {
    expect(retryFrom("claude", "not json")).toBeNull();
    expect(
      retryFrom("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "s" })),
    ).toBeNull();
    expect(retryFrom("claude", JSON.stringify({ type: "assistant" }))).toBeNull();
  });
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
    ['/bin/zsh -lc "pwd && rg --files"', "running pwd && rg --files"],
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
    JSON.stringify({
      run: "my-agent {prompt}",
      efforts: { codex: "high", futureAgent: "ultra" },
      future: { enabled: true },
    }),
  );

  await saveAgentChoice(cwd, { agent: "codex" });

  expect(await readAgentChoice(cwd)).toEqual({
    agent: "codex",
    effort: "high",
    run: "my-agent {prompt}",
  });
  expect(JSON.parse(readFileSync(join(cwd, ".leglas/watch.json"), "utf8"))).toEqual({
    run: "my-agent {prompt}",
    efforts: { codex: "high", futureAgent: "ultra" },
    future: { enabled: true },
    agent: "codex",
  });
});

test("remembers effort separately for each built-in agent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-effort-"));

  await saveAgentChoice(cwd, { agent: "claude", effort: "low" });
  await saveAgentChoice(cwd, { agent: "codex", effort: "xhigh" });
  await saveAgentChoice(cwd, { agent: "claude" });

  expect(await readAgentChoice(cwd)).toEqual({ agent: "claude", effort: "low", run: null });
  expect(JSON.parse(readFileSync(join(cwd, ".leglas/watch.json"), "utf8"))).toEqual({
    agent: "claude",
    efforts: { claude: "low", codex: "xhigh" },
  });

  await saveAgentChoice(cwd, { agent: "claude", effort: null });
  expect(await readAgentChoice(cwd)).toEqual({ agent: "claude", effort: null, run: null });
  expect(JSON.parse(readFileSync(join(cwd, ".leglas/watch.json"), "utf8"))).toEqual({
    agent: "claude",
    efforts: { codex: "xhigh" },
  });
});

test("a custom choice stores its validated template for the runner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-custom-agent-"));

  await saveAgentChoice(cwd, { agent: "custom", run: "my-agent -p {prompt}" });

  expect(await readAgentChoice(cwd)).toEqual({
    agent: "custom",
    effort: null,
    run: "my-agent -p {prompt}",
  });
});

test("an inherited object key is not accepted as a built-in agent id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-agent-id-"));
  mkdirSync(join(cwd, ".leglas"));
  writeFileSync(join(cwd, ".leglas/watch.json"), JSON.stringify({ agent: "toString" }));

  expect(await readAgentChoice(cwd)).toEqual({ agent: null, effort: null, run: null });
});
