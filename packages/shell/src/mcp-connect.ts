export type McpClient = "claude" | "other";

export type McpConnectOption = {
  codeLabel: string;
  copyLabel: string;
  description: string;
  label: string;
  nextStep: string;
  snippet: string;
};

/**
 * The two setup shapes Leglas can hand to an MCP host.
 *
 * These are named for the agents people are likely to recognize, not for
 * implementation details such as a filename. What matters here is whether a
 * client accepts Claude's command or standard MCP JSON.
 */
export const MCP_CONNECT_OPTIONS: Record<McpClient, McpConnectOption> = {
  claude: {
    codeLabel: "Terminal command",
    copyLabel: "Copy Claude Code command",
    description: "Add Leglas with one terminal command.",
    label: "Claude Code",
    nextStep:
      "Run this command from your project, then ask Claude to list your Leglas directions.",
    snippet: "claude mcp add leglas -- npx -y leglas-mcp",
  },
  other: {
    codeLabel: "MCP configuration",
    copyLabel: "Copy MCP configuration",
    description: "Use standard MCP JSON with another coding agent.",
    label: "Codex, Cursor & others",
    nextStep:
      "Add this configuration in your client's MCP settings, restart the client, then ask it to list your Leglas directions.",
    snippet: `{
  "mcpServers": {
    "leglas": { "command": "npx", "args": ["-y", "leglas-mcp"] }
  }
}`,
  },
};

export type McpCopyState = "blocked" | "copied" | "copying" | "idle";

export function copyActionLabel(option: McpConnectOption, state: McpCopyState): string {
  if (state === "copying") return "Copying…";
  if (state === "copied") return "Copied";
  return option.copyLabel;
}

export function connectionStatus(connected: boolean): { detail: string; title: string } {
  return connected
    ? {
        title: "Agent connected",
        detail: "Leglas received activity from an MCP agent in this project.",
      }
    : {
        title: "Waiting for agent activity",
        detail: "This updates after the agent uses a Leglas tool.",
      };
}
