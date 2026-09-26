import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

/**
 * The repo is also an Agent Plugin, and nothing else checks that half:
 * plugin.json and mcp.json are published by being committed, and a client skips
 * an invalid component without complaint. The schemas are the standard's,
 * vendored under schemas/ so the test stays off the network.
 */

const root = join(import.meta.dirname, "..");

const read = (path: string): string => readFileSync(join(root, path), "utf8");

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const readJson = (path: string): { [key: string]: JsonValue } => JSON.parse(read(path));

const schema = (name: string): { [key: string]: JsonValue } =>
  readJson(`schemas/agent-plugins-1.0.0/${name}.schema.json`);

/**
 * strict:false because ajv's strict mode rejects legal constructs in the
 * standard's own schemas.
 */
const validator = new Ajv2020({ strict: false, allErrors: true });

function violations(manifest: { [key: string]: JsonValue }, against: string): string[] {
  const validate = validator.compile(schema(against));

  if (validate(manifest)) return [];

  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

describe("the plugin manifests", () => {
  test("plugin.json conforms to the Agent Plugins schema", () => {
    expect(violations(readJson("plugin.json"), "plugin")).toEqual([]);
  });

  test("mcp.json conforms to the Agent Plugins schema", () => {
    expect(violations(readJson("mcp.json"), "mcp")).toEqual([]);
  });

  /**
   * The vendored schemas answer for one version, so targeting a newer one
   * should fail here, not validate against the wrong schema.
   */
  test("both manifests target the version of the standard we vendor", () => {
    for (const [manifest, name] of [
      ["plugin.json", "plugin"],
      ["mcp.json", "mcp"],
    ] as const) {
      expect(readJson(manifest)["$schema"]).toBe(schema(name)["$id"]);
    }
  });
});

/**
 * Enough YAML to read one scalar: quoted or not, with a trailing comment, with
 * CRLF. All ordinary YAML that a correct SKILL.md may use.
 */
function frontmatterField(source: string, field: string): string | null {
  const block = /^---\r?\n(.*?)\r?\n---/s.exec(source);

  if (block === null) return null;
  const line = new RegExp(String.raw`^${field}:[ \t]*(.*)$`, "m").exec(block[1] ?? "");

  if (line === null) return null;

  const value = (line[1] ?? "").trim();
  // Inside quotes a # is part of the value; outside them it opens a comment,
  // and YAML wants whitespace before it.
  const quoted = /^(["'])(.*)\1$/.exec(value);

  return quoted !== null ? (quoted[2] ?? "") : value.replace(/\s+#.*$/, "").trim();
}

describe("the plugin's components", () => {
  /**
   * Skills are found by position (§7.1): a directory under skills/ holding a
   * SKILL.md. Nothing imports them, so a rename silently drops the skill.
   */
  test("every skill directory holds a SKILL.md naming itself", () => {
    const directories = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).not.toHaveLength(0);

    for (const directory of directories) {
      const source = read(`skills/${directory}/SKILL.md`);
      const where = `skills/${directory}/SKILL.md`;

      expect(frontmatterField(source, "name"), `${where} names a different skill`).toBe(directory);
      // An agent matches requests against the description, so a skill without
      // one is never reached.
      expect(frontmatterField(source, "description") ?? "", `${where} has no description`).not.toBe(
        "",
      );
    }
  });

  /**
   * The server entry names the npm package, so a rename breaks it for everyone
   * who installs the plugin and nothing locally. Command and args are read
   * together, since `npx -y leglas-mcp` and bare `leglas-mcp` are both valid.
   * Only stdio entries name a package; revisit this if the server moves to
   * HTTP.
   */
  test("mcp.json launches the package this repository publishes", () => {
    type Server = { type: string; command?: string; args?: string[] };

    const manifest: { mcpServers: Record<string, Server> } = JSON.parse(read("mcp.json"));
    const servers = manifest.mcpServers;
    const published = readJson("packages/mcp/package.json")["name"];

    const launched = Object.values(servers)
      .filter((server) => server.type === "stdio")
      .flatMap((server) => [server.command ?? "", ...(server.args ?? [])]);

    expect(launched).toContain(published);
  });

  /**
   * publish.yml refuses a tag that disagrees with these; catching it here costs
   * a commit, not a new tag.
   */
  test("the plugin version matches both published packages", () => {
    const declared = readJson("plugin.json")["version"];

    expect(readJson("packages/cli/package.json")["version"]).toBe(declared);
    expect(readJson("packages/mcp/package.json")["version"]).toBe(declared);
  });
});
