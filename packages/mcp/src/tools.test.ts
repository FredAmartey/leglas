import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

import { UNRESOLVED_PROJECT, fixedProject, hostProject } from "./project.js";
import { registerLeglasTools, type LeglasTools } from "./tools.js";

const cleanups: LeglasTools[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((tools) => tools.shutdown()));
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-mcp-"));
}

/** A linked in-process pair: the same wire protocol a host speaks, no stdio. */
async function connect(
  cwd: string,
  options: { touches?: { count: number } } = {},
): Promise<Client> {
  const server = new McpServer({ name: "leglas-test", version: "0.0.0" });
  // A silent engagement, so no test beats a real port; the recording variant
  // proves the wiring where a test asks for it.
  const engagement = {
    touch: () => {
      if (options.touches) options.touches.count += 1;
    },
    stop: async () => {},
  };
  cleanups.push(registerLeglasTools(server, { project: fixedProject(cwd), engagement }));
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ envelope: Record<string, unknown>; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return {
    envelope: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
    isError: result.isError === true,
  };
}

describe("the MCP face", () => {
  test("lists the same tools the CLI offers", async () => {
    const client = await connect(scratch());

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "add",
      "classify",
      "explore",
      "init",
      "keep",
      "list",
      "requests",
      "scaffold",
      "show",
      "start",
    ]);
  });

  test("add registers a local preview and returns the CLI's envelope", async () => {
    const dir = scratch();
    const client = await connect(dir);

    const { envelope, isError } = await call(client, "add", {
      title: "Aurora",
      url: "/?v-hero=aurora",
      note: "One line on the idea.",
    });

    expect(isError).toBe(false);
    expect(envelope["ok"]).toBe(true);
    expect(envelope["added"]).toBe("Aurora");
    const written = JSON.parse(readFileSync(join(dir, ".leglas/previews.json"), "utf8"));
    expect(written.previews[0].title).toBe("Aurora");
  });

  test("show answers for one direction, file behind it included", async () => {
    const dir = scratch();
    const client = await connect(dir);
    await call(client, "add", { title: "Aurora", url: "/?v-hero=aurora", note: "Warm." });
    await call(client, "add", { title: "Dusk", url: "/?v-hero=dusk" });

    const { envelope, isError } = await call(client, "show", { title: "Aurora" });

    expect(isError).toBe(false);
    const direction = envelope["direction"] as Record<string, unknown>;
    expect(direction["note"]).toBe("Warm.");
    expect(direction["target"]).toBe(".leglas/variants/hero/aurora.tsx");
    expect(envelope["comparedWith"]).toContain("Dusk");
    expect(envelope["comparedWith"]).not.toContain("Aurora");
  });

  test("show marks an unknown title as an error, with the CLI's message", async () => {
    const client = await connect(scratch());

    const { envelope, isError } = await call(client, "show", { title: "Nope" });

    expect(isError).toBe(true);
    expect(envelope["ok"]).toBe(false);
    expect(String(envelope["error"])).toContain("No direction called");
  });

  test("add with a branch carries the warning about the missing devCommand", async () => {
    const client = await connect(scratch());

    const { envelope } = await call(client, "add", {
      title: "PR",
      url: "/",
      branch: "feature/hero",
    });

    expect(envelope["branch"]).toBe("feature/hero");
    expect(String(envelope["warning"])).toContain("devCommand");
  });

  test("a failed add is marked as an error, with the CLI's message", async () => {
    const dir = scratch();
    const client = await connect(dir);
    await call(client, "add", { title: "Aurora", url: "/?v-hero=aurora" });

    const { envelope, isError } = await call(client, "add", {
      title: "Aurora",
      url: "/?v-hero=again",
    });

    expect(isError).toBe(true);
    expect(String(envelope["error"])).toContain("Aurora");
  });

  test("list shows what add registered", async () => {
    const dir = scratch();
    const client = await connect(dir);
    await call(client, "add", { title: "Aurora", url: "/?v-hero=aurora" });

    const { envelope } = await call(client, "list", {});

    const previews = envelope["previews"] as { title: string; local: boolean }[];
    expect(previews.some((preview) => preview.title === "Aurora" && preview.local)).toBe(true);
  });

  test("classify routes a dependency change to a checkout", async () => {
    const client = await connect(scratch());

    const { envelope } = await call(client, "classify", {
      changes: [{ path: "package.json", kind: "change" }],
    });

    expect(envelope["level"]).toBe("checkout");
    expect(String(envelope["reason"])).toContain("dependency");
  });

  test("explore briefs the set without prescribing designs", async () => {
    const client = await connect(scratch());

    const { envelope } = await call(client, "explore", { surface: "hero", count: 4 });

    expect(envelope["ok"]).toBe(true);
    expect(String(envelope["instructions"])).toContain("Build 4 design directions");
    expect(String(envelope["instructions"])).toContain(".leglas/variants/hero/");
  });

  test("explore based on a direction asks for variants instead", async () => {
    const client = await connect(scratch());

    const { envelope } = await call(client, "explore", {
      surface: "hero",
      count: 3,
      basedOn: "Aurora",
    });

    expect(envelope["ok"]).toBe(true);
    expect(String(envelope["instructions"])).toContain('variations of the "Aurora" direction');
  });

  test("add accepts a file preview for the greenfield case", async () => {
    const client = await connect(scratch());

    const { envelope, isError } = await call(client, "add", {
      title: "Aurora",
      file: ".leglas/pages/aurora.html",
    });

    expect(isError).toBe(false);
    expect(envelope["file"]).toBe(".leglas/pages/aurora.html");
  });

  test("working the queue marks the session engaged", async () => {
    const touches = { count: 0 };
    const client = await connect(scratch(), { touches });

    await call(client, "requests", {});
    await call(client, "list", {});
    await call(client, "requests", { clear: true });

    // Only the queue tool signals engagement; browsing previews does not.
    expect(touches.count).toBe(2);
  });

  test("requests is empty for a fresh project", async () => {
    const client = await connect(scratch());

    const { envelope } = await call(client, "requests", {});

    expect(envelope["ok"]).toBe(true);
    expect(envelope["requests"]).toEqual([]);
  });

  test("start boots the viewer, is idempotent, and shutdown stops it", async () => {
    const dir = scratch();
    const client = await connect(dir);

    const first = await call(client, "start", { port: 0 });
    expect(first.envelope["ok"]).toBe(true);
    const url = String(first.envelope["url"]);
    expect(url).toContain("/leglas");

    const health = await fetch(`${url}/api/health`);
    expect(health.ok).toBe(true);

    const second = await call(client, "start", {});
    expect(second.envelope["alreadyRunning"]).toBe(true);
    expect(String(second.envelope["url"])).toBe(url);

    await cleanups[0]?.shutdown();
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  });
});

/**
 * An Agent Plugins client starts a plugin's MCP server in the plugin's own
 * install directory, so the working directory names a copy of Leglas rather
 * than anyone's project. These go through a real client to prove the tools
 * follow the host to the project instead.
 */
describe("a host that works somewhere other than the project", () => {
  async function connectWithRoots(
    cwd: string,
    roots: string[],
    pluginRoot?: string,
  ): Promise<Client> {
    const server = new McpServer({ name: "leglas-test", version: "0.0.0" });
    cleanups.push(
      registerLeglasTools(server, {
        project: hostProject(server.server, { cwd, ...(pluginRoot && { pluginRoot }) }),
      }),
    );
    const client = new Client(
      { name: "test-host", version: "0.0.0" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: "project" })),
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  test("registers into the project the host declares, never the plugin directory", async () => {
    const pluginRoot = scratch();
    const project = scratch();
    const client = await connectWithRoots(pluginRoot, [project], pluginRoot);

    const { isError } = await call(client, "add", { title: "Aurora", url: "/?v-hero=aurora" });

    expect(isError).toBe(false);
    const written = JSON.parse(readFileSync(join(project, ".leglas/previews.json"), "utf8"));
    expect(written.previews[0].title).toBe("Aurora");
    expect(existsSync(join(pluginRoot, ".leglas"))).toBe(false);
  });

  test("init writes into the project, so AGENTS.md never lands in a plugin cache", async () => {
    const pluginRoot = scratch();
    const project = scratch();
    const client = await connectWithRoots(pluginRoot, [project], pluginRoot);

    await call(client, "init", {});

    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(pluginRoot, "AGENTS.md"))).toBe(false);
  });

  test("says there is no project rather than acting on the plugin directory", async () => {
    const pluginRoot = scratch();
    const client = await connectWithRoots(pluginRoot, [], pluginRoot);

    const { envelope, isError } = await call(client, "init", {});

    expect(isError).toBe(true);
    expect(envelope["ok"]).toBe(false);
    expect(envelope["error"]).toBe(UNRESOLVED_PROJECT);
    expect(existsSync(join(pluginRoot, "AGENTS.md"))).toBe(false);
  });
});
