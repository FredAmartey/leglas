import { describe, expect, test } from "vitest";

import { AGENTS_MARKER_END, AGENTS_MARKER_START, planInit } from "./init.js";

const plan = (over: Partial<Parameters<typeof planInit>[0]> = {}) =>
  planInit({ agents: null, config: null, gitignore: null, ...over });

function write(result: ReturnType<typeof planInit>, path: string) {
  return result.writes.find((entry) => entry.path === path);
}

describe("planInit", () => {
  test("the section it writes into a new AGENTS.md teaches the loop an agent follows", () => {
    const contents = write(plan(), "AGENTS.md")?.contents ?? "";

    expect(contents).toContain(AGENTS_MARKER_START);
    // Additive authoring, which is what keeps switching instant.
    expect(contents.toLowerCase()).toContain("beside");
    expect(contents.toLowerCase()).toContain("never replace");
    expect(contents).toContain("defaults to what it renders today");
    // The live loop: viewer first, register as each lands. The viewer step
    // comes before build-and-register, or nothing is open while the rail fills.
    expect(contents).toContain("Before building, make sure the interface is up");
    expect(contents).toContain("Register each direction as it lands");
    expect(contents.indexOf("make sure the interface is up")).toBeLessThan(
      contents.indexOf("Build one direction at a time"),
    );
    expect(contents).toContain('npx leglas show "<title>" --screenshot');
    expect(contents).toContain("--width 390");
    expect(contents.indexOf("Register each direction as it lands")).toBeLessThan(
      contents.indexOf("Then look at it"),
    );
    // A request created by the running interface does not repeat setup.
    expect(contents).toMatch(/already\s+completed exploration, request collection/);
    expect(contents).toMatch(/Do not\s+repeat `explore`, `requests`, `list`/);
    expect(contents).toContain("or server startup");
    // The hands-free path, so agents can offer it.
    expect(contents).toContain("npx leglas watch --run");
    expect(contents).toContain("{prompt}");
    // The images a request can carry.
    expect(contents).toContain(".leglas/captures/");
    expect(contents).toContain("Look at them before changing anything.");

    for (const command of ["npx leglas new", "npx leglas add", "npx leglas list"]) {
      expect(contents).toContain(command);
    }
  });

  test("appends to an existing AGENTS.md without disturbing it", () => {
    const result = plan({ agents: "# Project\n\nRun the tests before committing.\n" });
    const contents = write(result, "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("Run the tests before committing.");
    expect(contents).toContain(AGENTS_MARKER_START);
    expect(contents.indexOf("Run the tests")).toBeLessThan(contents.indexOf(AGENTS_MARKER_START));
  });

  // Projects commit these markers, so the tests use the text on disk, not the
  // module's constants: a renamed marker has to break them.
  const onDisk = "# Project\n\n<!-- leglas:start -->\nold text\n<!-- leglas:end -->\n";

  test("does not add a second copy when the section is already there", () => {
    expect(write(plan({ agents: onDisk }), "AGENTS.md")).toBeUndefined();
  });

  test("replaces the section when asked to update it, keeping the project's own text", () => {
    const existing = `${onDisk}\n## Our notes\n\nKeep this.\n`;
    const result = planInit({ agents: existing, config: null, gitignore: null, force: true });
    const contents = write(result, "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("# Project");
    expect(contents).toContain("Keep this.");
    expect(contents).not.toContain("old text");
    expect(contents.split("<!-- leglas:start -->")).toHaveLength(2);
    expect(contents.split("<!-- leglas:end -->")).toHaveLength(2);
  });

  test("creates a starter config when the project has none", () => {
    expect(write(plan(), "leglas.config.ts")?.contents).toContain("previews");
  });

  test("never overwrites an existing config, which is the user's to own", () => {
    const result = plan({ config: "export default { previews: [] };\n" });

    expect(write(result, "leglas.config.ts")).toBeUndefined();
  });

  // The ignore entry every command that writes into .leglas/ shares with this one.
  test.each([
    [null, [".leglas/"]],
    ["node_modules\ndist\n", ["node_modules", "dist", ".leglas/"]],
    // A longer path is not the entry.
    [".leglas/variants\n", [".leglas/\n"]],
  ])("ignores .leglas/ in a .gitignore of %j, keeping what is there", (gitignore, kept) => {
    const result = plan({ gitignore }).gitignore;

    for (const text of kept) expect(result).toContain(text);
  });

  test("ends the .gitignore in exactly one newline", () => {
    const result = plan({ gitignore: "node_modules" }).gitignore;

    expect(result?.endsWith("\n")).toBe(true);
    expect(result?.endsWith("\n\n")).toBe(false);
  });

  // With or without the trailing slash, and with whitespace around it.
  test.each([".leglas/\n", "node_modules\n.leglas/\n", ".leglas\n", "  .leglas/  \n"])(
    "leaves a .gitignore of %j alone, since it already ignores the directory",
    (gitignore) => {
      expect(plan({ gitignore }).gitignore).toBeNull();
    },
  );

  test("reports when there is nothing left to do", () => {
    const existing = `${AGENTS_MARKER_START}\nx\n${AGENTS_MARKER_END}\n`;

    const result = plan({
      agents: existing,
      config: "export default {};",
      gitignore: ".leglas/\n",
    });

    expect(result.writes).toEqual([]);
    expect(result.gitignore).toBeNull();
  });
});
