import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const workflow = readFileSync(new URL(".github/workflows/publish.yml", import.meta.url), "utf8");

function script(name: string): string {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  const block = step?.split("        run: |\n")[1]?.match(/^(?:          .*\n|\n)+/)?.[0];
  if (block === undefined) throw new Error(`No run block for ${name}.`);
  return block.split("\n").map((line) => line.slice(10)).join("\n");
}

function runStep(name: string, version: string): { args: string[]; notes: string | null } {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-publish-"));
  try {
    // Functions intercept every external command in these steps, so the real
    // workflow logic runs without publishing packages or creating a release.
    const stubs = `
      pnpm() { printf '%s\\n' "$@"; }
      gh() { if [ "$2" = view ]; then return 1; fi; printf '%s\\n' "$@"; }
      node() { if [ "\${3:-}" = --title ]; then printf 'A release'; else printf 'Release body.\\n'; fi; }
    `;
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", stubs + script(name)], {
      cwd, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: `v${version}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return {
      args: result.stdout.trim().split("\n"),
      notes: name.startsWith("Create") ? readFileSync(join(cwd, "notes.md"), "utf8") : null,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("release channel", () => {
  test.each(["Publish leglas", "Publish leglas-mcp"])("%s sends prereleases to next and stable releases to latest", (name) => {
    expect(runStep(name, "1.2.0-rc.1").args).toEqual(["publish", "--access", "public", "--no-git-checks", "--tag", "next"]);
    expect(runStep(name, "1.2.0").args).toEqual(["publish", "--access", "public", "--no-git-checks"]);
  });

  test.each(["1.2.0", "1.2.0-rc.1"])("creates the matching GitHub release for %s", (version) => {
    const { args, notes } = runStep("Create the GitHub Release from the changelog entry", version);
    expect(args).toEqual(["release", "create", `v${version}`, "--verify-tag", "--title", `${version}: A release`, "--notes-file", "notes.md",
      ...(version.includes("-") ? ["--prerelease"] : [])]);
    expect(notes).toContain("Release body.");
    expect(notes).toContain(`changelog/#v${version}`);
  });
});
