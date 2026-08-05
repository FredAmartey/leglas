import { describe, expect, test } from "vitest";

import { AGENTS_MARKER_END, AGENTS_MARKER_START, planInit } from "./init.js";

const plan = (over: Partial<Parameters<typeof planInit>[0]> = {}) =>
  planInit({ agents: null, config: null, gitignore: null, ...over });

function write(result: ReturnType<typeof planInit>, path: string) {
  return result.writes.find((entry) => entry.path === path);
}

describe("planInit", () => {
  test("creates AGENTS.md when the project has none", () => {
    expect(write(plan(), "AGENTS.md")?.contents).toContain(AGENTS_MARKER_START);
  });

  test("appends to an existing AGENTS.md without disturbing it", () => {
    const result = plan({ agents: "# Project\n\nRun the tests before committing.\n" });
    const contents = write(result, "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("Run the tests before committing.");
    expect(contents).toContain(AGENTS_MARKER_START);
    expect(contents.indexOf("Run the tests")).toBeLessThan(contents.indexOf(AGENTS_MARKER_START));
  });

  test("does not add a second copy when the section is already there", () => {
    const existing = `# Project\n\n${AGENTS_MARKER_START}\nold text\n${AGENTS_MARKER_END}\n`;

    expect(write(plan({ agents: existing }), "AGENTS.md")).toBeUndefined();
  });

  test("replaces the section when asked to update it", () => {
    const existing = `# Project\n\n${AGENTS_MARKER_START}\nold text\n${AGENTS_MARKER_END}\n`;
    const result = planInit({ agents: existing, config: null, gitignore: null, force: true });
    const contents = write(result, "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("# Project");
    expect(contents).not.toContain("old text");
    expect(contents.match(new RegExp(AGENTS_MARKER_START, "g"))).toHaveLength(1);
  });

  test("teaches additive authoring, which is what keeps switching instant", () => {
    const contents = write(plan(), "AGENTS.md")?.contents ?? "";

    expect(contents.toLowerCase()).toContain("beside");
    expect(contents.toLowerCase()).toContain("never replace");
  });

  test("choreographs the live loop: viewer first, register as each lands", () => {
    const contents = write(plan(), "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("Before building, make sure the interface is up");
    expect(contents).toContain("Register each direction as it lands");
    // The viewer beat must come before the build-and-register beat, or the
    // user has nothing open while the rail fills in.
    expect(contents.indexOf("make sure the interface is up")).toBeLessThan(
      contents.indexOf("Build one direction at a time"),
    );
  });

  test("teaches the hands-free path so agents can offer it", () => {
    const contents = write(plan(), "AGENTS.md")?.contents ?? "";

    expect(contents).toContain("leglas watch --run");
    expect(contents).toContain("{prompt}");
  });

  test("names the commands an agent needs", () => {
    const contents = write(plan(), "AGENTS.md")?.contents ?? "";

    for (const command of ["leglas new", "leglas add", "leglas list"]) {
      expect(contents).toContain(command);
    }
  });

  test("creates a starter config when the project has none", () => {
    expect(write(plan(), "leglas.config.ts")?.contents).toContain("previews");
  });

  test("never overwrites an existing config, which is the user's to own", () => {
    const result = plan({ config: "export default { previews: [] };\n" });

    expect(write(result, "leglas.config.ts")).toBeUndefined();
  });

  test("ignores the working directory", () => {
    expect(plan().gitignore).toContain(".leglas/");
  });

  test("leaves .gitignore alone when it already ignores the directory", () => {
    expect(plan({ gitignore: ".leglas/\n" }).gitignore).toBeNull();
  });

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
