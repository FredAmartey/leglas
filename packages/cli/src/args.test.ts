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

  // The command line docs point at `leglas <command> --help`, so every command
  // must answer it.
  test.each([
    "init",
    "new",
    "explore",
    "classify",
    "add",
    "list",
    "log",
    "show",
    "share",
    "requests",
    "watch",
    "keep",
  ])("leglas %s --help prints the help", (command) => {
    expect(parseArgs([command, "--help"]).kind).toBe("help");
    expect(parseArgs([command, "-h"]).kind).toBe("help");
  });

  test("help wins over whatever else the command was given", () => {
    expect(parseArgs(["show", "Aurora", "--screenshot", "--help"]).kind).toBe("help");
    expect(parseArgs(["keep", "Aurora", "-h", "--to", "src/hero.tsx"]).kind).toBe("help");
  });

  test("a mistyped command asking for help gets it, since the help lists the real ones", () => {
    expect(parseArgs(["shwo", "--help"]).kind).toBe("help");
    // Without the ask it is still refused.
    expect(parseArgs(["shwo"]).kind).toBe("error");
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

describe("the explore command", () => {
  test("defaults to three new directions", () => {
    const result = parseArgs(["explore", "hero"]);

    expect(result.kind).toBe("explore");

    if (result.kind !== "explore") return;
    expect(result.count).toBe(3);
    expect(result.basedOn).toBeNull();
  });

  test("takes a direction title to build variants of", () => {
    const result = parseArgs(["explore", "hero", "--based-on", "Aurora", "--count", "4"]);

    expect(result.kind).toBe("explore");

    if (result.kind !== "explore") return;
    expect(result.basedOn).toBe("Aurora");
    expect(result.count).toBe(4);
  });

  test("refuses --based-on with no title, which would brief variants of nothing", () => {
    const result = parseArgs(["explore", "hero", "--based-on"]);

    expect(result.kind).toBe("error");

    if (result.kind !== "error") return;
    expect(result.message).toContain("--based-on");
  });

  test("--build with a brief asks the running Leglas to build the set", () => {
    const result = parseArgs([
      "explore",
      "hero",
      "--build",
      "--brief",
      "A hero for a cooking app",
      "--port",
      "4321",
    ]);

    expect(result).toMatchObject({
      kind: "explore",
      surface: "hero",
      build: true,
      brief: "A hero for a cooking app",
      port: 4321,
      count: 3,
    });
  });

  test("--build without a brief is refused, naming the flags that would do", () => {
    const result = parseArgs(["explore", "hero", "--build"]);

    expect(result.kind).toBe("error");

    if (result.kind !== "error") return;
    expect(result.message).toContain("--brief");
    expect(result.message).toContain("--based-on");
  });

  test("--build with --based-on builds variations, and the brief becomes optional", () => {
    expect(parseArgs(["explore", "hero", "--build", "--based-on", "Menu"])).toMatchObject({
      kind: "explore",
      build: true,
      basedOn: "Menu",
      brief: null,
    });
  });

  test("a brief without --build is refused rather than silently ignored", () => {
    const result = parseArgs(["explore", "hero", "--brief", "Anything"]);

    expect(result.kind).toBe("error");

    if (result.kind !== "error") return;
    expect(result.message).toContain("--build");
  });
});

describe("add --based-on", () => {
  test("records the direction a variant is based on", () => {
    const result = parseArgs([
      "add",
      "--title",
      "Meridian Dusk",
      "--url",
      "/?v-hero=meridian-dusk",
      "--based-on",
      "Meridian",
    ]);

    expect(result.kind).toBe("add");

    if (result.kind !== "add") return;
    expect(result.preview.basedOn).toBe("Meridian");
  });

  test("is optional, and absent means an ordinary root", () => {
    const result = parseArgs(["add", "--title", "Ledger", "--url", "/?v-hero=ledger"]);

    expect(result.kind).toBe("add");

    if (result.kind !== "add") return;
    expect(result.preview.basedOn).toBeUndefined();
  });
});

describe("add --asked-for", () => {
  test("records the change that was asked for, in the words that were typed", () => {
    const result = parseArgs([
      "add",
      "--title",
      "Softer pouch",
      "--url",
      "/?v-hero=softer",
      "--asked-for",
      "the pouch looks fake when it turns",
    ]);

    expect(result.kind).toBe("add");

    if (result.kind !== "add") return;
    expect(result.preview.askedFor).toBe("the pouch looks fake when it turns");
  });

  test("is optional, because most directions were never asked for in words", () => {
    const result = parseArgs(["add", "--title", "Ledger", "--url", "/?v-hero=ledger"]);

    expect(result.kind).toBe("add");

    if (result.kind !== "add") return;
    expect(result.preview.askedFor).toBeUndefined();
  });
});

describe("the show command", () => {
  test("takes a screenshot width and explicit server port", () => {
    const result = parseArgs([
      "show",
      "Aurora",
      "--screenshot",
      "--width",
      "390",
      "--port=4200",
      "--json",
    ]);

    expect(result).toEqual({
      kind: "show",
      title: "Aurora",
      json: true,
      screenshot: true,
      width: 390,
      port: 4200,
    });
  });

  test("keeps metadata-only show as the default", () => {
    const result = parseArgs(["show", "Aurora"]);

    expect(result).toMatchObject({ screenshot: false, width: null, port: null });
  });

  test("width and port only make sense with a screenshot", () => {
    expect(parseArgs(["show", "Aurora", "--width", "390"])).toEqual({
      kind: "error",
      message: "leglas show --width needs --screenshot.",
    });
    expect(parseArgs(["show", "Aurora", "--port", "4100"])).toEqual({
      kind: "error",
      message: "leglas show --port needs --screenshot.",
    });
  });

  test("refuses widths outside the capture range", () => {
    for (const width of ["319", "3841", "wide"]) {
      expect(parseArgs(["show", "Aurora", "--screenshot", "--width", width]).kind).toBe("error");
    }
  });
});

describe("the share command", () => {
  test("no directions shares the rail; one shares it alone; two compare them", () => {
    expect(parseArgs(["share"])).toEqual({
      kind: "share",
      titles: [],
      reach: "open",
      tunnel: null,
      stop: false,
      rotate: false,
      revoke: null,
      port: null,
      json: false,
    });
    expect(parseArgs(["share", "Aurora"])).toMatchObject({ titles: ["Aurora"] });
    expect(parseArgs(["share", "Aurora", "Dusk", "--json"])).toMatchObject({
      titles: ["Aurora", "Dusk"],
      json: true,
    });
  });

  test("takes a reach, a tunnel and the port of a Leglas elsewhere", () => {
    expect(
      parseArgs(["share", "Aurora", "--reach", "listed", "--tunnel=ngrok", "--port", "4200"]),
    ).toMatchObject({ reach: "listed", tunnel: "ngrok", port: 4200 });
    expect(parseArgs(["share", "--tunnel", "none"])).toMatchObject({ tunnel: "none" });
  });

  test("stop ends the share and takes nothing that would start one", () => {
    expect(parseArgs(["share", "--stop", "--json"])).toMatchObject({ stop: true, json: true });
    expect(parseArgs(["share", "Aurora", "--stop"])).toEqual({
      kind: "error",
      message: "leglas share --stop ends the share; it takes no directions, reach or tunnel.",
    });
  });

  test("rotates every link, or revokes the one it names, and takes one of those at a time", () => {
    expect(parseArgs(["share", "--rotate"])).toMatchObject({ rotate: true, revoke: null });
    expect(parseArgs(["share", "--revoke=grant-2", "--json"])).toMatchObject({
      rotate: false,
      revoke: "grant-2",
      json: true,
    });
    expect(parseArgs(["share", "--rotate", "--revoke", "grant-2"])).toEqual({
      kind: "error",
      message: "leglas share takes one of --stop, --rotate or --revoke at a time.",
    });
    expect(parseArgs(["share", "Aurora", "--rotate"])).toEqual({
      kind: "error",
      message:
        "leglas share --rotate replaces every link; it takes no directions, reach or tunnel.",
    });
    expect(parseArgs(["share", "--revoke"])).toEqual({
      kind: "error",
      message: "--revoke needs a value.",
    });
  });

  test("refuses what it cannot share", () => {
    expect(parseArgs(["share", "A", "B", "C"])).toEqual({
      kind: "error",
      message:
        "leglas share takes one direction to share alone, or two to compare. Name none to share the rail.",
    });
    expect(parseArgs(["share", "--reach", "everything"])).toEqual({
      kind: "error",
      message: '--reach is open or listed, received "everything".',
    });
    expect(parseArgs(["share", "--tunnel", "ssh"])).toEqual({
      kind: "error",
      message: '--tunnel is cloudflared, ngrok or none, received "ssh".',
    });
    expect(parseArgs(["share", "--fast"])).toEqual({
      kind: "error",
      message: "leglas share does not take --fast.",
    });
  });
});

describe("the link command", () => {
  test("takes none, one or two directions and the port of a Leglas elsewhere", () => {
    expect(parseArgs(["link"])).toEqual({ kind: "link", titles: [], port: null, json: false });
    expect(parseArgs(["link", "Aurora", "Dusk", "--port=4200", "--json"])).toEqual({
      kind: "link",
      titles: ["Aurora", "Dusk"],
      port: 4200,
      json: true,
    });
    expect(parseArgs(["link", "A", "B", "C"])).toEqual({
      kind: "error",
      message:
        "leglas link takes one direction, or two to put side by side. Name none for the rail.",
    });
  });
});

describe("watch", () => {
  test("takes the agent command as one argument", () => {
    const result = parseArgs(["watch", "--run", "claude -p {prompt}"]);

    expect(result.kind).toBe("watch");

    if (result.kind !== "watch") return;
    expect(result.run).toBe("claude -p {prompt}");
    expect(result.port).toBeUndefined();
  });

  test("runs with no flags at all, on whatever was remembered", () => {
    const result = parseArgs(["watch"]);

    expect(result.kind).toBe("watch");

    if (result.kind !== "watch") return;
    expect(result.run).toBeUndefined();
  });

  test("takes the port Leglas is on, for the attachment heartbeat", () => {
    const result = parseArgs(["watch", "--run=codex exec {prompt}", "--port", "4200"]);

    expect(result.kind).toBe("watch");

    if (result.kind !== "watch") return;
    expect(result.run).toBe("codex exec {prompt}");
    expect(result.port).toBe(4200);
  });

  test("refuses --run with nothing after it", () => {
    const result = parseArgs(["watch", "--run"]);

    expect(result.kind).toBe("error");

    if (result.kind !== "error") return;
    expect(result.message).toContain("--run");
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    expect(parseArgs(["watch", "--verbose"]).kind).toBe("error");
  });

  // docs/cli.md: --json works on every command, watch included.
  test("takes --json, which prints one JSON line per event", () => {
    const result = parseArgs(["watch", "--json", "--run", "claude -p {prompt}"]);

    expect(result.kind).toBe("watch");

    if (result.kind !== "watch") return;
    expect(result.json).toBe(true);
    expect(result.run).toBe("claude -p {prompt}");
  });
});
