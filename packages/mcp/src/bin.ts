#!/usr/bin/env node
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installShutdown } from "leglas";

import { CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, startChannel } from "./channel.js";
import { hostProject } from "./project.js";
import { registerLeglasTools } from "./tools.js";

/**
 * The stdio face. A host that spawns this in the project directory gets the
 * CLI's contract, where the working directory names the project; a host that
 * spawns it somewhere else is asked where the project is. See project.ts.
 */

function version(): string {
  const require = createRequire(import.meta.url);
  // SAFETY: The MCP package includes its own manifest with the published version.
  const pkg = require("../package.json") as { version: string };

  return pkg.version;
}

const server = new McpServer(
  { name: "leglas", version: version() },
  // The channel capability and instructions are inert on hosts that do not
  // speak channels; on Claude Code they let change requests from the
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

// The host closing stdin is the ordinary way a stdio server ends; signals
// cover a host that kills instead, and the terminal closing under the host
// (SIGHUP, whose default is to end the process without any of this). Either
// way the viewer stops with us, and so does any agent it started, which runs
// in a process group of its own and does not hear the terminal go.
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
