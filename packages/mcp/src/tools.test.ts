import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, test } from "vitest";

import { registerLeglasTools, type LeglasTools } from "./tools.js";

const cleanups: LeglasTools[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((tools) => tools.shutdown()));
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-mcp-"));
}

/** A linked in-process pair: the same wire protocol a host speaks, no stdio. */
async function connect(cwd: string): Promise<Client> {
  const server = new McpServer({ name: "leglas-test", version: "0.0.0" });
  cleanups.push(registerLeglasTools(server, { cwd }));
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

  test("explore based on a direction asks for shades instead", async () => {
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
