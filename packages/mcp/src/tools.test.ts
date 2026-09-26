import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseArgs } from "leglas";
import { afterEach, describe, expect, test, vi } from "vitest";

import { writeServerInfo } from "../../server/src/server-info.js";

import { UNRESOLVED_PROJECT, fixedProject, hostProject, type Project } from "./project.js";
import { registerLeglasTools, type LeglasTools } from "./tools.js";

const cleanups: LeglasTools[] = [];

const captureServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((tools) => tools.shutdown()));
  vi.unstubAllEnvs();
  await Promise.all(
    captureServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-mcp-"));
}

/** A linked in-process pair: the same wire protocol a host speaks, no stdio. */
async function connect(
  cwd: string,
  options: { touches?: { count: number }; project?: Project } = {},
): Promise<Client> {
  const server = new McpServer({ name: "leglas-test", version: "0.0.0" });

  // A silent engagement, so no test beats a real port; the recording variant
  // proves the wiring where a test asks for it.
  const engagement = {
    touch: async () => {
      if (options.touches) options.touches.count += 1;
    },
    stop: async () => {},
  };

  cleanups.push(
    registerLeglasTools(server, { project: options.project ?? fixedProject(cwd), engagement }),
  );
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return client;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

async function call(
  client: Client,
  name: string,
  args: { [key: string]: JsonValue },
): Promise<{ envelope: { [key: string]: JsonValue }; isError: boolean }> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const first = result.content[0];

  const envelope: { [key: string]: JsonValue } = JSON.parse(
    first?.type === "text" ? first.text : "{}",
  );

  return {
    envelope,
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
      "share",
      "show",
      "start",
    ]);
  });

  test("share reaches the running Leglas through the CLI, and says so when there is none", async () => {
    const dir = scratch();
    // A port that was free a moment ago: nothing answers it, so the project's
    // own record points at nothing and no other Leglas on this machine is asked.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` completed on a TCP host, so `address` is an IP address and port.
    const port = (closed.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await writeServerInfo(dir, { port, url: `http://localhost:${port}`, pid: process.pid });
    const client = await connect(dir);

    const { envelope, isError } = await call(client, "share", { titles: ["Aurora"] });

    expect(isError).toBe(true);
    expect(envelope).toEqual({
      ok: false,
      error: "Leglas is not running here. Start it with npx leglas, then try again.",
    });
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
    expect(envelope["direction"]).toMatchObject({
      note: "Warm.",
      target: ".leglas/variants/hero/aurora.tsx",
    });
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

  test("show with a screenshot returns the PNG beside its JSON envelope", async () => {
    const dir = scratch();
    const image = Buffer.from("png from capture");
    const file = ".leglas/captures/show/aurora-390.png";
    mkdirSync(join(dir, ".leglas/captures/show"), { recursive: true });
    writeFileSync(join(dir, file), image);

    const captureServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });

      if (req.url === "/leglas/api/health") return res.end(JSON.stringify({ ok: true }));

      return res.end(
        JSON.stringify({
          ok: true,
          file,
          width: 390,
          height: 700,
          viewport: 390,
          errors: [],
        }),
      );
    });

    captureServers.push(captureServer);
    await new Promise<void>((resolve) => captureServer.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` completed on a TCP host, so `address` is an IP address and port.
    const port = (captureServer.address() as import("node:net").AddressInfo).port;
    await writeServerInfo(dir, { port, url: `http://localhost:${port}`, pid: process.pid });
    const client = await connect(dir);
    await call(client, "add", { title: "Aurora", url: "/?v-hero=aurora" });

    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "show",
        arguments: { title: "Aurora", screenshot: true, width: 390 },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[1]).toEqual({
      type: "image",
      data: image.toString("base64"),
      mimeType: "image/png",
    });
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

    expect(envelope["previews"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Aurora", local: true })]),
    );
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

  // The one test that boots the bundle the package publishes, and a booting
  // server asks each agent CLI whether it is logged in. Stand-ins that answer
  // "no" come first on PATH, so no real CLI runs.
  test.skipIf(process.platform === "win32")(
    "start boots the viewer, is idempotent, and shutdown stops it",
    async () => {
      const dir = scratch();
      const bin = scratch();
      const asked = join(bin, "asked.log");

      for (const name of ["claude", "codex", "cursor-agent"]) {
        const stub = join(bin, name);
        writeFileSync(stub, `#!/bin/sh\necho ${name} >> "${asked}"\nexit 1\n`);
        chmodSync(stub, 0o755);
      }

      vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
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

      // Every login question went to a stand-in, and all of them have been
      // asked, so PATH can go back.
      await vi.waitFor(
        () => {
          expect(readFileSync(asked, "utf8").split("\n").filter(Boolean).sort()).toEqual([
            "claude",
            "codex",
            "cursor-agent",
          ]);
        },
        { timeout: 15_000 },
      );
    },
  );
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

describe("the MCP face refuses what the command line refuses", () => {
  const refusals: {
    name: string;
    tool: string;
    args: { [key: string]: JsonValue };
    argv: string[];
    /** The command line's message for this, as it shipped before the tools asked the rules. */
    error: string;
  }[] = [
    {
      name: "add with nothing to show",
      tool: "add",
      args: { title: "Aurora" },
      argv: ["add", "--title", "Aurora"],
      error:
        "leglas add needs --url (for example --url '/?v-hero=aurora') or --file for a page Leglas serves itself.",
    },
    {
      name: "add with an empty note",
      tool: "add",
      args: { title: "Aurora", url: "/", note: "" },
      argv: ["add", "--title", "Aurora", "--url", "/", "--note", ""],
      error: "--note needs a value.",
    },
    {
      name: "show with a width but no screenshot",
      tool: "show",
      args: { title: "Aurora", width: 390 },
      argv: ["show", "Aurora", "--width", "390"],
      error: "leglas show --width needs --screenshot.",
    },
    {
      name: "share stopping with a direction named",
      tool: "share",
      args: { titles: ["Aurora"], stop: true },
      argv: ["share", "Aurora", "--stop"],
      error: "leglas share --stop ends the share; it takes no directions, reach or tunnel.",
    },
    {
      name: "share stopping with a reach",
      tool: "share",
      args: { reach: "listed", stop: true },
      argv: ["share", "--reach", "listed", "--stop"],
      error: "leglas share --stop ends the share; it takes no directions, reach or tunnel.",
    },
    {
      name: "scaffold with an empty baseline path",
      tool: "scaffold",
      args: { surface: "hero", from: "" },
      argv: ["new", "hero", "--from", ""],
      error: "--from needs a path, for example --from src/Hero.tsx",
    },
  ];

  // No project to act on, so a refusal that comes back proves it ran before the tool looked for one.
  const nowhere: Project = { locate: async () => ({ ok: false, reason: UNRESOLVED_PROJECT }) };

  test.each(refusals)("$name, in the command line's words", async ({ tool, args, argv, error }) => {
    expect(parseArgs(argv)).toEqual({ kind: "error", message: error });
    const client = await connect(scratch(), { project: nowhere });
    const { envelope, isError } = await call(client, tool, args);

    expect(isError).toBe(true);
    expect(envelope).toEqual({ ok: false, error });
  });

  test("takes an explore count the command line takes", async () => {
    expect(parseArgs(["explore", "hero", "--count", "30"]).kind).toBe("explore");
    const client = await connect(scratch());
    const { envelope, isError } = await call(client, "explore", { surface: "hero", count: 30 });

    expect(isError).toBe(false);
    expect(envelope["ok"]).toBe(true);
  });
});
