import { describe, expect, test } from "vitest";

import { parseArgs } from "./args.js";

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (result.kind !== "run") throw new Error(`expected run, got ${result.kind}`);
  return result.options;
}

describe("parseArgs", () => {
  test("runs with defaults when given nothing", () => {
    const options = ok([]);

    expect(options).toEqual({
      port: undefined,
      userPort: undefined,
      configPath: undefined,
      open: true,
      json: false,
    });
  });

  test("takes the Leglas port", () => {
    expect(ok(["--port", "4200"]).port).toBe(4200);
  });

  test("takes the target dev server port", () => {
    expect(ok(["--user-port", "5173"]).userPort).toBe(5173);
  });

  test("accepts --flag=value as well as --flag value", () => {
    expect(ok(["--port=4200"]).port).toBe(4200);
  });

  test("takes an explicit config path", () => {
    expect(ok(["--config", "./other.config.ts"]).configPath).toBe("./other.config.ts");
  });

  test("suppresses opening the browser", () => {
    expect(ok(["--no-open"]).open).toBe(false);
  });

  test("switches to machine-readable output for agents", () => {
    expect(ok(["--json"]).json).toBe(true);
  });

  test("asks for help", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-h"]).kind).toBe("help");
  });

  test("asks for the version", () => {
    expect(parseArgs(["--version"]).kind).toBe("version");
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    const result = parseArgs(["--prot", "4200"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--prot");
  });

  test("rejects a port that is not a number", () => {
    const result = parseArgs(["--port", "abc"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--port");
  });

  test("rejects a flag that is missing its value", () => {
    const result = parseArgs(["--port"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--port");
  });

  test("rejects a port outside the valid range", () => {
    expect(parseArgs(["--port", "99999"]).kind).toBe("error");
    expect(parseArgs(["--port", "-1"]).kind).toBe("error");
  });

  test("rejects an unknown command rather than silently booting", () => {
    const result = parseArgs(["start"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("start");
  });
});

describe("the new command", () => {
  test("takes the surface to scaffold", () => {
    const result = parseArgs(["new", "hero"]);

    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.surface).toBe("hero");
  });

  test("asks for a surface name when none is given", () => {
    const result = parseArgs(["new"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message.toLowerCase()).toContain("surface");
  });

  test("can print the scaffold instead of writing it", () => {
    const result = parseArgs(["new", "hero", "--print"]);

    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.print).toBe(true);
  });

  test("defaults to writing, since printing is the escape hatch", () => {
    const result = parseArgs(["new", "hero"]);

    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.print).toBe(false);
  });

  test("rejects a flag that belongs to booting, not scaffolding", () => {
    expect(parseArgs(["new", "hero", "--user-port", "3000"]).kind).toBe("error");
  });
});

describe("the add command", () => {
  test("takes a title and a url", () => {
    const result = parseArgs(["add", "--title", "Aurora", "--url", "/?v-hero=aurora"]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.preview.title).toBe("Aurora");
    expect(result.preview.url).toBe("/?v-hero=aurora");
  });

  test("takes an optional note and tags", () => {
    const result = parseArgs([
      "add",
      "--title",
      "Aurora",
      "--url",
      "/?a",
      "--note",
      "Warm gradient.",
      "--tag",
      "Hero",
      "--tag",
      "Warm",
    ]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.preview.note).toBe("Warm gradient.");
    expect(result.preview.tags).toEqual(["Hero", "Warm"]);
  });

  test("requires a title", () => {
    const result = parseArgs(["add", "--url", "/?a"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--title");
  });

  test("requires a url", () => {
    const result = parseArgs(["add", "--title", "Aurora"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--url");
  });

  test("emits json for agents when asked", () => {
    const result = parseArgs(["add", "--title", "A", "--url", "/?a", "--json"]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.json).toBe(true);
  });
});

describe("the list command", () => {
  test("needs no arguments", () => {
    expect(parseArgs(["list"]).kind).toBe("list");
  });

  test("emits json for agents when asked", () => {
    const result = parseArgs(["list", "--json"]);

    expect(result.kind).toBe("list");
    if (result.kind !== "list") return;
    expect(result.json).toBe(true);
  });
});

describe("the classify command", () => {
  test("collects changed and rewritten paths with their intent", () => {
    const result = parseArgs([
      "classify",
      "--change",
      "package.json",
      "--rewrite",
      "src/theme.css",
      "--json",
    ]);

    expect(result.kind).toBe("classify");
    if (result.kind !== "classify") return;
    expect(result.changes).toEqual([
      { path: "package.json", kind: "change" },
      { path: "src/theme.css", kind: "rewrite" },
    ]);
    expect(result.json).toBe(true);
  });

  test("accepts --flag=value as well as --flag value", () => {
    const result = parseArgs(["classify", "--rewrite=src/hero.tsx"]);

    expect(result.kind).toBe("classify");
    if (result.kind !== "classify") return;
    expect(result.changes[0]?.path).toBe("src/hero.tsx");
  });

  test("needs at least one declared path", () => {
    const result = parseArgs(["classify"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("classify");
  });

  test("rejects flags it does not know", () => {
    expect(parseArgs(["classify", "--deps"]).kind).toBe("error");
  });
});

describe("adding a branch preview", () => {
  test("takes the branch to back the preview with", () => {
    const result = parseArgs(["add", "--title", "PR", "--url", "/", "--branch", "feature/hero"]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.preview.branch).toBe("feature/hero");
  });

  test("leaves branch undefined for an ordinary preview", () => {
    const result = parseArgs(["add", "--title", "A", "--url", "/?a"]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.preview.branch).toBeUndefined();
  });
});

describe("adding a file preview", () => {
  test("takes a file instead of a url", () => {
    const result = parseArgs(["add", "--title", "Aurora", "--file", ".leglas/pages/aurora.html"]);

    expect(result.kind).toBe("add");
    if (result.kind !== "add") return;
    expect(result.preview.file).toBe(".leglas/pages/aurora.html");
    expect(result.preview.url).toBeUndefined();
  });

  test("still requires a url or a file", () => {
    const result = parseArgs(["add", "--title", "Aurora"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("--file");
  });
});
