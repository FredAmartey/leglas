import { describe, expect, test } from "vitest";

import { parseArgs } from "./args.js";

const add = (...flags: string[]) => [
  "add",
  "--title",
  "Aurora",
  "--url",
  "/?v-hero=aurora",
  ...flags,
];

describe("parseArgs", () => {
  test.each<[argv: string[], parsed: object]>([
    [
      [],
      {
        kind: "run",
        options: {
          port: undefined,
          userPort: undefined,
          configPath: undefined,
          open: true,
          json: false,
        },
      },
    ],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["--version"], { kind: "version" }],
    // Help wins over whatever else the command was given.
    [["show", "Aurora", "--screenshot", "--help"], { kind: "help" }],
    [["keep", "Aurora", "-h", "--to", "src/hero.tsx"], { kind: "help" }],
    // A mistyped command asking for help gets it, since the help lists the real ones.
    [["shwo", "--help"], { kind: "help" }],
    [
      ["show", "Aurora", "--screenshot", "--width", "390", "--port=4200", "--json"],
      { kind: "show", title: "Aurora", json: true, screenshot: true, width: 390, port: 4200 },
    ],
    [
      ["share"],
      {
        kind: "share",
        titles: [],
        reach: "open",
        tunnel: null,
        stop: false,
        rotate: false,
        revoke: null,
        port: null,
        json: false,
      },
    ],
    [
      ["remove", "Aurora", "Dusk", "--json"],
      { kind: "remove", titles: ["Aurora", "Dusk"], json: true },
    ],
    // None opens the rail, one a direction, two side by side.
    [["link"], { kind: "link", titles: [], port: null, json: false }],
    [
      ["link", "Aurora", "Dusk", "--port=4200", "--json"],
      { kind: "link", titles: ["Aurora", "Dusk"], port: 4200, json: true },
    ],
  ])("parses %j exactly", (argv, parsed) => {
    expect(parseArgs(argv)).toEqual(parsed);
  });

  test.each<[argv: string[], parsed: object]>([
    [["--port", "4200"], { options: { port: 4200 } }],
    [["--user-port", "5173"], { options: { userPort: 5173 } }],
    [["--port=4200"], { options: { port: 4200 } }],
    [["--config", "./other.config.ts"], { options: { configPath: "./other.config.ts" } }],
    [["--no-open"], { options: { open: false } }],
    [["--json"], { options: { json: true } }],
    // Writing is the default, since printing is the escape hatch.
    [["new", "hero"], { kind: "new", surface: "hero", print: false }],
    [["new", "hero", "--print"], { kind: "new", print: true }],
    // Branch, basedOn and askedFor stay unset on an ordinary root that was never asked for.
    [
      add(),
      {
        kind: "add",
        json: false,
        preview: {
          title: "Aurora",
          url: "/?v-hero=aurora",
          branch: undefined,
          basedOn: undefined,
          askedFor: undefined,
        },
      },
    ],
    [
      add("--note", "Warm gradient.", "--tag", "Hero", "--tag", "Warm"),
      { preview: { note: "Warm gradient.", tags: ["Hero", "Warm"] } },
    ],
    [add("--json"), { kind: "add", json: true }],
    [add("--branch", "feature/hero"), { preview: { branch: "feature/hero" } }],
    [
      ["add", "--title", "Aurora", "--file", ".leglas/pages/aurora.html"],
      { preview: { file: ".leglas/pages/aurora.html", url: undefined } },
    ],
    [add("--based-on", "Meridian"), { preview: { basedOn: "Meridian" } }],
    [
      add("--asked-for", "the pouch looks fake when it turns"),
      { preview: { askedFor: "the pouch looks fake when it turns" } },
    ],
    [["list"], { kind: "list", json: false }],
    [["list", "--json"], { kind: "list", json: true }],
    [
      ["classify", "--change", "package.json", "--rewrite", "src/theme.css", "--json"],
      {
        kind: "classify",
        changes: [
          { path: "package.json", kind: "change" },
          { path: "src/theme.css", kind: "rewrite" },
        ],
        json: true,
      },
    ],
    [["classify", "--rewrite=src/hero.tsx"], { changes: [{ path: "src/hero.tsx" }] }],
    [["explore", "hero"], { kind: "explore", count: 3, basedOn: null }],
    [["explore", "hero", "--based-on", "Aurora", "--count", "4"], { basedOn: "Aurora", count: 4 }],
    [
      ["explore", "hero", "--build", "--brief", "A hero for a cooking app", "--port", "4321"],
      {
        kind: "explore",
        surface: "hero",
        build: true,
        brief: "A hero for a cooking app",
        port: 4321,
        count: 3,
      },
    ],
    // With --based-on there is a direction to go on, so the brief becomes optional.
    [
      ["explore", "hero", "--build", "--based-on", "Menu"],
      { kind: "explore", build: true, basedOn: "Menu", brief: null },
    ],
    [["show", "Aurora"], { screenshot: false, width: null, port: null }],
    // No directions shares the rail; one shares it alone; two compare them.
    [["share", "Aurora"], { titles: ["Aurora"] }],
    [["share", "Aurora", "Dusk", "--json"], { titles: ["Aurora", "Dusk"], json: true }],
    [
      ["share", "Aurora", "--reach", "listed", "--tunnel=ngrok", "--port", "4200"],
      { reach: "listed", tunnel: "ngrok", port: 4200 },
    ],
    [["share", "--tunnel", "none"], { tunnel: "none" }],
    [["share", "--stop", "--json"], { stop: true, json: true }],
    [["share", "--rotate"], { rotate: true, revoke: null }],
    [["share", "--revoke=grant-2", "--json"], { rotate: false, revoke: "grant-2", json: true }],
    // The agent command is one argument, and the port is for the attachment heartbeat.
    [
      ["watch", "--run", "claude -p {prompt}"],
      { kind: "watch", run: "claude -p {prompt}", port: undefined },
    ],
    // No flags at all runs on whatever was remembered.
    [["watch"], { kind: "watch", run: undefined }],
    [
      ["watch", "--run=codex exec {prompt}", "--port", "4200"],
      { run: "codex exec {prompt}", port: 4200 },
    ],
    // docs/cli.md: --json works on every command, watch included.
    [["watch", "--json", "--run", "claude -p {prompt}"], { json: true, run: "claude -p {prompt}" }],
  ])("takes %j", (argv, parsed) => {
    expect(parseArgs(argv)).toMatchObject(parsed);
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

  test.each<[argv: string[], message: string]>([
    // Refused rather than ignored, or silently booting.
    [["--prot", "4200"], expect.stringContaining("--prot")],
    [["--port", "abc"], expect.stringContaining("--port")],
    [["--port"], expect.stringContaining("--port")],
    [["--port", "99999"], expect.any(String)],
    [["--port", "-1"], expect.any(String)],
    [["start"], expect.stringContaining("start")],
    [["shwo"], expect.any(String)],
    [["new"], expect.stringMatching(/surface/i)],
    // A flag that belongs to booting, not scaffolding.
    [["new", "hero", "--user-port", "3000"], expect.any(String)],
    [["add", "--url", "/?a"], expect.stringContaining("--title")],
    [
      ["add", "--title", "Aurora"],
      "leglas add needs --url (for example --url '/?v-hero=aurora') or --file for a page Leglas serves itself.",
    ],
    [["classify"], expect.stringContaining("classify")],
    [["classify", "--deps"], expect.any(String)],
    // --based-on with no title would brief variants of nothing.
    [["explore", "hero", "--based-on"], expect.stringContaining("--based-on")],
    // --build without a brief names the flags that would do.
    [["explore", "hero", "--build"], expect.stringMatching(/--brief[\s\S]*--based-on/)],
    [["explore", "hero", "--brief", "Anything"], expect.stringContaining("--build")],
    [["show", "Aurora", "--width", "390"], "leglas show --width needs --screenshot."],
    [["show", "Aurora", "--port", "4100"], "leglas show --port needs --screenshot."],
    [["show", "Aurora", "--screenshot", "--width", "319"], expect.any(String)],
    [["show", "Aurora", "--screenshot", "--width", "3841"], expect.any(String)],
    [["show", "Aurora", "--screenshot", "--width", "wide"], expect.any(String)],
    [
      ["share", "Aurora", "--stop"],
      "leglas share --stop ends the share; it takes no directions, reach or tunnel.",
    ],
    [
      ["share", "--rotate", "--revoke", "grant-2"],
      "leglas share takes one of --stop, --rotate or --revoke at a time.",
    ],
    [
      ["share", "Aurora", "--rotate"],
      "leglas share --rotate replaces every link; it takes no directions, reach or tunnel.",
    ],
    [["share", "--revoke"], "--revoke needs a value."],
    [
      ["share", "A", "B", "C"],
      "leglas share takes one direction to share alone, or two to compare. Name none to share the rail.",
    ],
    [["share", "--reach", "everything"], '--reach is open or listed, received "everything".'],
    [["share", "--tunnel", "ssh"], '--tunnel is cloudflared, ngrok or none, received "ssh".'],
    [["share", "--fast"], "leglas share does not take --fast."],
    [["remove"], 'leglas remove needs a direction title, for example: npx leglas remove "Aurora"'],
    [["remove", "Aurora", "--force"], "leglas remove does not take --force."],
    [
      ["link", "A", "B", "C"],
      "leglas link takes one direction, or two to put side by side. Name none for the rail.",
    ],
    [["watch", "--run"], expect.stringContaining("--run")],
    [["watch", "--verbose"], expect.any(String)],
  ])("refuses %j, saying why", (argv, message) => {
    expect(parseArgs(argv)).toEqual({ kind: "error", message });
  });
});
