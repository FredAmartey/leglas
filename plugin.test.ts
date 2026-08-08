import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

/**
 * The repository is an Agent Plugin as well as two npm packages, and that half
 * of it is guarded by nothing else. plugin.json and mcp.json are published by
 * being committed: no build reads them, no test imported them, and no install
 * step would fail on a typo. A client is what discovers the mistake, and the
 * spec tells it to skip an invalid component rather than complain, so the
 * plugin simply arrives with a piece missing.
 *
 * So the checks below stand in for the client. The schemas are the ones the
 * standard publishes, vendored under schemas/ because a test that reaches the
 * network fails for reasons that have nothing to do with the change under it.
 */

const root = import.meta.dirname;

const read = (path: string): string => readFileSync(join(root, path), "utf8");
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

const schema = (name: string): Record<string, unknown> =>
  readJson(`schemas/agent-plugins-1.0.0/${name}.schema.json`);

/**
 * strict:false because the vendored schemas are someone else's: ajv's strict
 * mode rejects perfectly legal schema constructs it considers unclear, and
 * arguing with the standard's own file is not this test's job.
 */
const validator = new Ajv2020({ strict: false, allErrors: true });

function violations(manifest: Record<string, unknown>, against: string): string[] {
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
   * The manifests name the version of the standard they target, and the
   * vendored copies answer for one version only. Targeting a newer one is a
   * real decision with real work behind it, so it should arrive as a failure
   * here rather than as validation that quietly stopped meaning anything.
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
 * Enough YAML to read one scalar, which is all this needs. The value may be
 * quoted, may carry a trailing comment, and the file may have been written on
 * a machine with CRLF endings. All three are ordinary YAML, and a parse that
 * trips on them rejects a SKILL.md that is perfectly correct, leaving whoever
 * wrote it staring at a green file and a red test.
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
   * Skills are discovered by position (§7.1): a directory under skills/ with a
   * SKILL.md in it. Nothing imports these files, so a rename or a move takes
   * the skill out of the plugin silently, and the skill is the whole of what
   * an agent reads before it has run anything.
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
      // The description is what an agent matches a request against before it
      // has opened anything, so a skill without one is a skill nothing reaches.
      expect(frontmatterField(source, "description") ?? "", `${where} has no description`).not.toBe(
        "",
      );
    }
  });

  /**
   * The server entry names a package on npm, which makes it the one reference
   * in the repository that renaming the package cannot break locally. It
   * breaks for everyone who installs the plugin instead.
   *
   * Read across command and args together, because `npx -y leglas-mcp` and a
   * bare `leglas-mcp` are both legal spellings of the same launch. Only stdio
   * entries carry a package name at all; if this plugin ever served the server
   * over HTTP instead, there would be nothing here to check and this should be
   * reconsidered rather than quietly dropped.
   */
  test("mcp.json launches the package this repository publishes", () => {
    type Server = { type: string; command?: string; args?: string[] };
    const servers = readJson("mcp.json")["mcpServers"] as Record<string, Server>;
    const published = readJson("packages/mcp/package.json")["name"];

    const launched = Object.values(servers)
      .filter((server) => server.type === "stdio")
      .flatMap((server) => [server.command ?? "", ...(server.args ?? [])]);

    expect(launched).toContain(published);
  });

  /**
   * publish.yml refuses a tag that disagrees with any of these, so they have to
   * match by the time a release runs. Catching the drift here means finding it
   * in the pull request that caused it rather than against a pushed tag, where
   * the fix is a new tag.
   */
  test("the plugin version matches both published packages", () => {
    const declared = readJson("plugin.json")["version"];

    expect(readJson("packages/cli/package.json")["version"]).toBe(declared);
    expect(readJson("packages/mcp/package.json")["version"]).toBe(declared);
  });
});
