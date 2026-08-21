import { describe, expect, test } from "vitest";

import {
  MCP_CONNECT_OPTIONS,
  connectionStatus,
  copyActionLabel,
} from "./mcp-connect.js";

describe("MCP connection options", () => {
  test("names recognizable clients instead of using a generic other option", () => {
    expect(MCP_CONNECT_OPTIONS.claude.label).toBe("Claude Code");
    expect(MCP_CONNECT_OPTIONS.other.label).toBe("Codex, Cursor & others");
    expect(MCP_CONNECT_OPTIONS.other.copyLabel).toBe("Copy MCP configuration");
  });

  test("uses non-interactive npx in both setup shapes", () => {
    expect(MCP_CONNECT_OPTIONS.claude.snippet).toContain("npx -y leglas-mcp");
    expect(JSON.parse(MCP_CONNECT_OPTIONS.other.snippet)).toEqual({
      mcpServers: {
        leglas: { command: "npx", args: ["-y", "leglas-mcp"] },
      },
    });
  });

  test("gives each path one concrete next step", () => {
    expect(MCP_CONNECT_OPTIONS.claude.nextStep).toContain("ask Claude to list");
    expect(MCP_CONNECT_OPTIONS.other.nextStep).toContain("restart the client");
  });
});

describe("MCP connection state", () => {
  test("keeps the copy action verb-first and confirms its result", () => {
    const option = MCP_CONNECT_OPTIONS.claude;
    expect(copyActionLabel(option, "idle")).toBe("Copy Claude Code command");
    expect(copyActionLabel(option, "copying")).toBe("Copying…");
    expect(copyActionLabel(option, "copied")).toBe("Copied");
    expect(copyActionLabel(option, "blocked")).toBe("Copy Claude Code command");
  });

  test("does not call an idle MCP process connected before it uses a tool", () => {
    expect(connectionStatus(false)).toEqual({
      title: "Waiting for agent activity",
      detail: "This updates after the agent uses a Leglas tool.",
    });
    expect(connectionStatus(true)).toEqual({
      title: "Agent connected",
      detail: "Leglas received activity from an MCP agent in this project.",
    });
  });
});
