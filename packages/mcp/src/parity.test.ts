import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseArgs } from "leglas";
import { afterAll, beforeAll, expect, test } from "vitest";

import { HELP } from "../../cli/src/help.js";

import { fixedProject } from "./project.js";
import { registerLeglasTools, type LeglasTools } from "./tools.js";

type Flag = { param: string } | { without: string };

type Face = {
  /** The command line's arguments that make the rest parse: the command and what it requires. */
  argv: string[];
  /** The MCP tool, or why there is none. */
  tool: { name: string } | { without: string };
  /** Tool parameters the command line takes as positional arguments. */
  positional: string[];
  flags: Record<string, Flag>;
};

function param(name: string): Flag {
  return { param: name };
}

function without(reason: string): Flag {
  return { without: reason };
}

const ENVELOPE = without("every tool answers with the --json envelope");

const RECORD = without(
  "a running Leglas is found from the record it writes; the flag is for one that record does not describe",
);

/**
 * Every flag of every command and what the MCP face does with it: the
 * parameter it becomes, or why the tool goes without it. A flag the parser
 * learns has to be placed here, so exposing it over MCP, or not, is a decision
 * someone makes rather than one nobody noticed.
 */
const FACES = {
  run: {
    argv: [],
    tool: { name: "start" },
    positional: [],
    flags: {
      // The tool also takes 0, for any free port. The command line refuses 0
      // because its port check also serves flags that name a running Leglas.
      "--port": param("port"),
      "--user-port": without(
        "the dev server comes from the project's config, or port 3000 without one, and an agent sets it there",
      ),
      "--config": without(
        "the config is found by searching upward from the project the server resolved",
      ),
      "--no-open": without("start returns the URL for the host to show and never opens a browser"),
      "--json": ENVELOPE,
    },
  },
  new: {
    argv: ["new", "hero"],
    tool: { name: "scaffold" },
    positional: ["surface"],
    flags: { "--from": param("from"), "--print": param("print"), "--json": ENVELOPE },
  },
  add: {
    argv: ["add", "--title", "Aurora", "--url", "/"],
    tool: { name: "add" },
    positional: [],
    flags: {
      "--title": param("title"),
      "--url": param("url"),
      "--note": param("note"),
      "--tag": param("tags"),
      "--branch": param("branch"),
      "--file": param("file"),
      "--based-on": param("basedOn"),
      "--asked-for": param("askedFor"),
      "--json": ENVELOPE,
    },
  },
  classify: {
    argv: ["classify", "--change", "package.json"],
    tool: { name: "classify" },
    positional: [],
    flags: { "--change": param("changes"), "--rewrite": param("changes"), "--json": ENVELOPE },
  },
  list: { argv: ["list"], tool: { name: "list" }, positional: [], flags: { "--json": ENVELOPE } },
  show: {
    argv: ["show", "Aurora", "--screenshot"],
    tool: { name: "show" },
    positional: ["title"],
    flags: {
      "--screenshot": param("screenshot"),
      "--width": param("width"),
      "--port": RECORD,
      "--json": ENVELOPE,
    },
  },
  share: {
    argv: ["share"],
    tool: { name: "share" },
    positional: ["titles"],
    flags: {
      "--reach": param("reach"),
      "--stop": param("stop"),
      "--rotate": param("rotate"),
      "--revoke": param("revoke"),
      "--tunnel": without(
        "which tunnel runs is the machine's setup, so the tool takes the first one installed, as the command line does by default",
      ),
      "--port": RECORD,
      "--json": ENVELOPE,
    },
  },
  link: {
    argv: ["link"],
    tool: { name: "link" },
    positional: ["titles"],
    flags: { "--port": RECORD, "--json": ENVELOPE },
  },
  remove: {
    argv: ["remove", "Aurora"],
    tool: { name: "remove" },
    positional: ["titles"],
    flags: { "--json": ENVELOPE },
  },
  requests: {
    argv: ["requests"],
    tool: { name: "requests" },
    positional: [],
    flags: { "--clear": param("clear"), "--json": ENVELOPE },
  },
  explore: {
    argv: ["explore", "hero"],
    tool: { name: "explore" },
    positional: ["surface"],
    flags: {
      "--count": param("count"),
      "--based-on": param("basedOn"),
      "--build": without(
        "a build runs the person's own agent; an MCP host is that agent and builds from the brief",
      ),
      "--brief": without("goes with --build"),
      "--port": without("goes with --build"),
      "--json": ENVELOPE,
    },
  },
  keep: {
    argv: ["keep", "Aurora", "--to", "src/Hero.tsx"],
    tool: { name: "keep" },
    positional: ["title"],
    flags: { "--to": param("to"), "--json": ENVELOPE },
  },
  init: {
    argv: ["init"],
    tool: { name: "init" },
    positional: [],
    flags: { "--force": param("force"), "--json": ENVELOPE },
  },
  watch: {
    argv: ["watch"],
    tool: { without: "a terminal-held loop; hosts that speak channels get the same pushes" },
    positional: [],
    flags: {
      "--run": without("watch has no tool"),
      "--port": without("watch has no tool"),
      "--json": ENVELOPE,
    },
  },
  log: {
    argv: ["log"],
    tool: { without: "the log is Markdown in the project, which an agent reads directly" },
    positional: [],
    flags: { "--json": ENVELOPE },
  },
} satisfies Record<string, Face>;

type RouteFace = { tool: string; param?: string } | { without: string };

function tool(name: string, param?: string): RouteFace {
  return param === undefined ? { tool: name } : { tool: name, param };
}

const BUILD =
  "a set Leglas builds with the person's own agent; an MCP host is that agent and builds from explore's brief";

const UPDATE =
  "updating Leglas restarts the server a host is talking to, so the interface asks the person first";

const AGENT =
  "which agent the interface runs, and keeping it warm; an MCP host is already the agent";

const NOTES = "notes the person pins on a direction, which reach the agent inside a change request";

const RUN = "stops or reruns the interface's own agent run, which an MCP host is not";

/**
 * Every route the interface calls on its own Leglas, and the tool that does the
 * same for an agent, or why an agent goes without. A route the server learns
 * has to be placed here, as a flag has to be placed above.
 */
const ROUTES = {
  "GET /api/config": tool("list"),
  "GET /api/health": without(
    "the interface's check on the dev server; commands ask it to find a running Leglas",
  ),
  "GET /api/generate": without(BUILD),
  "POST /api/generate": without(BUILD),
  "POST /api/generate/stop": without(BUILD),
  "POST /api/generate/retry": without(BUILD),
  "POST /api/generate/replace": without(BUILD),
  "GET /api/update": without(UPDATE),
  "POST /api/update/check": without(UPDATE),
  "POST /api/update/skip": without(UPDATE),
  "POST /api/update/install": without(UPDATE),
  "GET /api/share": tool("share"),
  "POST /api/share": tool("share"),
  "POST /api/share/update": without(
    "sends the rail as the sharer's browser arranges it, which the command line can't see",
  ),
  "POST /api/share/grants": without(
    "not on the command line yet: a second link, named for the person it goes to",
  ),
  "POST /api/share/grants/revoke": tool("share", "revoke"),
  "POST /api/share/grants/extend": without("not on the command line yet: another day on one link"),
  "POST /api/share/allow": without(
    "widening a listed share is the person's call, made against the refusals the panel shows",
  ),
  "POST /api/share/rotate": tool("share", "rotate"),
  "POST /api/share/stop": tool("share", "stop"),
  "GET /api/previews/framing": without("whether a page lets the interface frame it"),
  "POST /api/previews/start": without("starts a branch direction's checkout when someone opens it"),
  "POST /api/previews/delete": tool("remove"),
  "POST /api/references": without("an image the person attaches to a change request"),
  "POST /api/request": without(
    "the person asking their agent for a change; an agent makes the change instead",
  ),
  "POST /api/capture": tool("show", "screenshot"),
  "POST /api/agents/warm": without(AGENT),
  "GET /api/agents": without(AGENT),
  "POST /api/agent": without(AGENT),
  "POST /api/watch": without(
    "the beat watch sends, and this server sends while an agent works the queue, so the interface's own agent steps aside",
  ),
  "GET /api/requests": tool("requests"),
  "POST /api/requests/cancel": without(RUN),
  "POST /api/requests/retry": without(RUN),
  "POST /api/requests/dismiss": without(
    "lets go of a request whose run failed or stopped, which is the person's call",
  ),
  "GET /api/annotations": without(NOTES),
  "POST /api/annotations": without(NOTES),
  "POST /api/annotations/update": without(NOTES),
  "POST /api/annotations/delete": without(NOTES),
  "POST /api/renames": without(
    "not on the command line yet: the rail's own name for a direction, which every command answers to",
  ),
} satisfies Record<string, RouteFace>;

/**
 * Every route the server answers for its own interface, as "METHOD path", read
 * with whitespace collapsed since the formatter wraps long conditions. A route
 * with no method test answers a GET. Routes only a share's viewers reach are
 * left out, and anything left unread fails the test.
 */
function serverRoutes() {
  const source = readFileSync(
    new URL("../../server/src/server.ts", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

  const methodFirst =
    /(?<remote>!?context\.remote && )?req\.method === "(?<method>GET|POST)" && path === `\$\{LEGLAS_PREFIX\}(?<route>\/api\/[^`$]*)`/g;

  const single =
    /(?<remote>!?context\.remote && )?path === `\$\{LEGLAS_PREFIX\}(?<route>\/api\/[^`$]*)`(?: && req\.method === "(?<method>GET|POST)")?/g;

  const grouped =
    /req\.method === "(?<method>GET|POST)" && \[(?<names>[^\]]*)\]\.some\( \(action\) => path === `\$\{LEGLAS_PREFIX\}(?<base>\/api\/[^`$]*)\$\{action\}`/g;

  const found: string[] = [];

  for (const match of source.matchAll(methodFirst)) {
    if (match.groups?.["remote"] === "context.remote && ") continue;
    found.push(`${match.groups?.["method"] ?? ""} ${match.groups?.["route"] ?? ""}`);
  }

  const rest = source.replace(methodFirst, "");

  for (const match of rest.matchAll(single)) {
    if (match.groups?.["remote"] === "context.remote && ") continue;
    found.push(`${match.groups?.["method"] ?? "GET"} ${match.groups?.["route"] ?? ""}`);
  }

  for (const match of rest.matchAll(grouped)) {
    for (const name of (match.groups?.["names"] ?? "").matchAll(/"([^"]+)"/g)) {
      found.push(
        `${match.groups?.["method"] ?? ""} ${match.groups?.["base"] ?? ""}${name[1] ?? ""}`,
      );
    }
  }

  const left = rest.replace(single, "").replace(grouped, "");

  // A prefix below /api/ answers a family of paths no table entry can name.
  const unread = [
    ...(left.match(/path === `\$\{LEGLAS_PREFIX\}\/api\/[^`]*`/g) ?? []),
    ...(left.match(/path\.startsWith\(`\$\{LEGLAS_PREFIX\}\/api\/[^`]+`\)/g) ?? []),
  ];

  return { found, unread };
}

// The scans below assume every flag is a quoted literal in args.ts and every
// command is dispatched from it.
const parser = readFileSync(new URL("../../cli/src/args.ts", import.meta.url), "utf8");

/** Every flag the parser names, apart from the two any command answers. */
const knownFlags = [
  ...new Set(
    [...parser.matchAll(/"(--[a-z][a-z-]*)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  ),
].filter((flag) => flag !== "--help" && flag !== "--version");

/** Every word in the parser that it takes as a command rather than a stray argument. */
const knownCommands = [
  ...new Set(
    [...parser.matchAll(/"([a-z]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  ),
].filter((word) => {
  const parsed = parseArgs([word]);

  return !(parsed.kind === "error" && parsed.message.startsWith("Unexpected argument"));
});

/** Whether the command answers a flag as one it does not know. */
function refusesAsUnknown(face: Face, flag: string): boolean {
  const parsed = parseArgs([...face.argv, flag, "1"]);

  return (
    parsed.kind === "error" &&
    (parsed.message.includes(`take ${flag}.`) || parsed.message.includes(`flag ${flag}.`))
  );
}

const cleanups: LeglasTools[] = [];

let parameters: Map<string, string[]>;

beforeAll(async () => {
  const server = new McpServer({ name: "leglas-parity", version: "0.0.0" });
  const engagement = { touch: async () => {}, stop: async () => {} };
  const project = fixedProject(mkdtempSync(join(tmpdir(), "leglas-parity-")));

  cleanups.push(registerLeglasTools(server, { project, engagement }));
  const client = new Client({ name: "parity-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();

  parameters = new Map(
    tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]),
  );
});

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((tools) => tools.shutdown()));
});

test("every command has a tool or a reason, and every MCP tool belongs to one command", () => {
  const named = Object.values(FACES).flatMap((face) =>
    "name" in face.tool ? [face.tool.name] : [],
  );

  expect(knownCommands.length).toBeGreaterThan(10);
  expect(["run", ...knownCommands].sort()).toEqual(Object.keys(FACES).sort());
  expect([...parameters.keys()].sort()).toEqual([...named].sort());
});

test("every MCP parameter is a flag or a positional argument of its command", () => {
  for (const face of Object.values(FACES)) {
    if (!("name" in face.tool)) continue;

    const offered = parameters.get(face.tool.name) ?? [];

    const mapped = new Set([
      ...Object.values(face.flags).flatMap((flag) => ("param" in flag ? [flag.param] : [])),
      ...face.positional,
    ]);

    expect(offered.filter((parameter) => !mapped.has(parameter))).toEqual([]);
    expect([...mapped].filter((parameter) => !offered.includes(parameter))).toEqual([]);
  }
});

test("each command takes exactly the flags placed under it", () => {
  expect(knownFlags.length).toBeGreaterThan(20);

  for (const [command, face] of Object.entries(FACES)) {
    const takes = knownFlags.filter((flag) => !refusesAsUnknown(face, flag));

    expect(takes.sort(), command).toEqual(Object.keys(face.flags).sort());
  }
});

test("--help and the table agree on every command and flag", () => {
  const blocks = HELP.split("\n\n");
  const faces = new Map<string, Face>(Object.entries(FACES));

  const usage = new Map(
    (blocks.find((block) => block.startsWith("Usage\n")) ?? "").split("\n").flatMap((line) => {
      const match = /^ +leglas (\S+)/.exec(line);

      return match?.[1] === undefined ? [] : [[match[1] === "[options]" ? "run" : match[1], line]];
    }),
  );

  // An option line starts with its flag; one named later in a line is only mentioned.
  const sections = new Map(
    blocks.flatMap((block) => {
      const heading = /^Options(?: for ([a-z]+))?\n/.exec(block);

      if (heading === null) return [];

      const listed = [...block.matchAll(/^ +(--[a-z][a-z-]*)/gm)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      );

      return [[heading[1] ?? "run", listed]];
    }),
  );

  expect([...usage.keys()].sort()).toEqual([...faces.keys()].sort());
  expect([...sections.keys()].filter((command) => !faces.has(command))).toEqual([]);

  for (const [command, face] of faces) {
    const listed = sections.get(command) ?? [];
    const line = usage.get(command) ?? "";

    const missing = Object.entries(face.flags).flatMap(([flag, how]) =>
      how === ENVELOPE || listed.includes(flag) || line.includes(flag) ? [] : [flag],
    );

    expect(missing, command).toEqual([]);
    expect(
      listed.filter((flag) => !(flag in face.flags)),
      `Options for ${command}`,
    ).toEqual([]);
  }
});

test("every route the interface calls has a tool or a reason", () => {
  const { found, unread } = serverRoutes();

  expect(unread, "a route the scan cannot read").toEqual([]);
  expect(found.length).toBeGreaterThan(30);
  expect([...new Set(found)].sort()).toEqual(Object.keys(ROUTES).sort());
});

test("each tool a route names takes the parameter it names", () => {
  for (const [route, face] of Object.entries(ROUTES)) {
    if (!("tool" in face)) continue;

    expect(parameters.has(face.tool), route).toBe(true);

    if (face.param !== undefined) expect(parameters.get(face.tool), route).toContain(face.param);
  }
});
