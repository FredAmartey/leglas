#!/usr/bin/env node
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installShutdown } from "leglas";

import { CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, startChannel } from "./channel.js";
import { hostProject } from "./project.js";
import { registerLeglasTools } from "./tools.js";

/**
 * Stdio server. The working directory names the project unless the host started
 * it elsewhere; see project.ts.
 */

function version(): string {
  const require = createRequire(import.meta.url);
  // SAFETY: The MCP package includes its own manifest with the published version.
  const pkg = require("../package.json") as { version: string };

  return pkg.version;
}

const server = new McpServer(
  { name: "leglas", version: version() },
  // Inert on hosts without channels. On Claude Code, change requests from the
  // interface arrive in the open session as events.
  { capabilities: { experimental: CHANNEL_CAPABILITY }, instructions: CHANNEL_INSTRUCTIONS },
);

const project = hostProject(server.server, {
  cwd: process.cwd(),
  override: process.env["LEGLAS_PROJECT_DIR"],
  pluginRoot: process.env["LEGLAS_PLUGIN_ROOT"],
});

const tools = registerLeglasTools(server, { project });

let channel: { stop(): void } | null = null;

// Stdin closing is the normal end. The signals cover a host that kills us and a
// closed terminal (SIGHUP). Agents the viewer started run in their own process
// group, so only this stops them.
const shutdown = installShutdown(async () => {
  channel?.stop();
  await tools.shutdown();
  process.exit(0);
});

const transport = new StdioServerTransport();

transport.onclose = () => {
  void shutdown();
};

await server.connect(transport);

// Only after connect: a notification with no transport throws.
channel = startChannel(server, { project });
