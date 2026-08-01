#!/usr/bin/env node
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerLeglasTools } from "./tools.js";

/**
 * The stdio face. An agent host spawns this in the project directory, which
 * is the same contract as the CLI: the working directory names the project.
 */

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

const server = new McpServer({ name: "leglas", version: version() });
const tools = registerLeglasTools(server, { cwd: process.cwd() });

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await tools.shutdown();
  process.exit(0);
};

// The host closing stdin is the ordinary way a stdio server ends; signals
// cover a host that kills instead. Either way the viewer stops with us.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
transport.onclose = () => {
  void shutdown();
};

await server.connect(transport);
