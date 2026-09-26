export type RunOptions = {
  /** Port for Leglas itself. Undefined means the server's default. */
  port: number | undefined;
  /** Port the target dev server is on, overriding the config. */
  userPort: number | undefined;
  configPath: string | undefined;
  open: boolean;
  /** Machine-readable output, for agents driving the CLI. */
  json: boolean;
};

export type AddPreview = {
  title: string;
  url: string | undefined;
  note: string | undefined;
  tags: string[] | undefined;
  branch: string | undefined;
  file: string | undefined;
  /** The direction this preview is a variant of; the rail groups them. */
  basedOn: string | undefined;
  /** The change that was asked for, in the words that were typed. */
  askedFor: string | undefined;
};

export type ClassifyChange = {
  path: string;
  kind: "change" | "rewrite";
};

/** How far a viewer may reach into the dev server behind a share. */
export type ShareReach = "open" | "listed";

export type ShareTunnel = "cloudflared" | "ngrok" | "none";

const SHARE_TUNNELS: readonly ShareTunnel[] = ["cloudflared", "ngrok", "none"];

export type ParseResult =
  | { kind: "run"; options: RunOptions }
  | { kind: "new"; surface: string; print: boolean; json: boolean; from: string | undefined }
  | { kind: "add"; preview: AddPreview; json: boolean }
  | { kind: "classify"; changes: ClassifyChange[]; json: boolean }
  | { kind: "list"; json: boolean }
  | { kind: "log"; entry: string | null; json: boolean }
  | {
      kind: "show";
      title: string;
      json: boolean;
      screenshot: boolean;
      width: number | null;
      port: number | null;
    }
  | {
      kind: "share";
      /** None shares the rail; one shares that direction alone; two compare them. */
      titles: string[];
      reach: ShareReach;
      /** Null lets the running Leglas pick the first tunnel program it finds. */
      tunnel: ShareTunnel | null;
      stop: boolean;
      port: number | null;
      json: boolean;
    }
  | { kind: "requests"; json: boolean; clear: boolean }
  | { kind: "watch"; run: string | undefined; port: number | undefined; json: boolean }
  | {
      kind: "explore";
      surface: string;
      count: number;
      basedOn: string | null;
      json: boolean;
      /** Build the set with the configured agent instead of printing a brief for one. */
      build: boolean;
      brief: string | null;
      port: number | null;
    }
  | { kind: "keep"; title: string; to: string; json: boolean }
  | { kind: "init"; force: boolean; json: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const VALUE_FLAGS = new Set(["--port", "--user-port", "--config"]);

const BOOLEAN_FLAGS = new Set(["--no-open", "--json"]);

const MIN_SHOW_WIDTH = 320;

const MAX_SHOW_WIDTH = 3840;

function parsePort(flag: string, raw: string): { port: number } | { error: string } {
  if (!/^\d+$/.test(raw)) {
    return { error: `${flag} needs a number, received ${JSON.stringify(raw)}.` };
  }

  const port = Number(raw);

  if (port < 1 || port > 65535) {
    return { error: `${flag} must be between 1 and 65535, received ${port}.` };
  }

  return { port };
}

/**
 * Hand-rolled: five flags, and an unknown flag must be an error, which most
 * argument libraries get wrong by default.
 */
function parseNew(rest: string[]): ParseResult {
  let surface: string | undefined;
  let print = false;
  let json = false;
  let from: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;

    if (argument === "--from" || argument.startsWith("--from=")) {
      from = argument.includes("=") ? argument.split("=").slice(1).join("=") : rest[(index += 1)];

      if (from === undefined || from === "") {
        return { kind: "error", message: "--from needs a path, for example --from src/Hero.tsx" };
      }

      continue;
    }

    if (argument === "--print") {
      print = true;
      continue;
    }

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument.startsWith("-")) {
      return { kind: "error", message: `leglas new does not take ${argument}.` };
    }

    if (surface !== undefined) {
      return {
        kind: "error",
        message: `leglas new takes one surface name, received ${JSON.stringify(argument)} as well.`,
      };
    }

    surface = argument;
  }

  if (surface === undefined) {
    return {
      kind: "error",
      message: "leglas new needs a surface name, for example: npx leglas new hero",
    };
  }

  return { kind: "new", surface, print, json, from };
}

function parseAdd(rest: string[]): ParseResult {
  let title: string | undefined;
  let url: string | undefined;
  let note: string | undefined;
  let branch: string | undefined;
  let file: string | undefined;
  let basedOn: string | undefined;
  let askedFor: string | undefined;
  const tags: string[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;

    if (argument === "--json") {
      json = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    let value: string | undefined;

    if (equals === -1) {
      value = rest[index + 1];
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }

    if (
      ![
        "--title",
        "--url",
        "--note",
        "--tag",
        "--branch",
        "--file",
        "--based-on",
        "--asked-for",
      ].includes(flag)
    ) {
      return { kind: "error", message: `leglas add does not take ${flag}.` };
    }

    if (value === undefined || value === "") {
      return { kind: "error", message: `${flag} needs a value.` };
    }

    if (flag === "--title") title = value;
    else if (flag === "--url") url = value;
    else if (flag === "--note") note = value;
    else if (flag === "--branch") branch = value;
    else if (flag === "--file") file = value;
    else if (flag === "--based-on") basedOn = value;
    else if (flag === "--asked-for") askedFor = value;
    else tags.push(value);
  }

  if (title === undefined) {
    return {
      kind: "error",
      message: "leglas add needs --title, which is how the preview is identified.",
    };
  }

  if (url === undefined && file === undefined) {
    return {
      kind: "error",
      message:
        "leglas add needs --url (for example --url '/?v-hero=aurora') or --file for a page Leglas serves itself.",
    };
  }

  return {
    kind: "add",
    preview: {
      title,
      url,
      note,
      tags: tags.length > 0 ? tags : undefined,
      branch,
      file,
      basedOn,
      askedFor,
    },
    json,
  };
}

/**
 * Each file is tagged with intent: --change creates a file or mounts a branch
 * point in one, --rewrite alters what an existing file renders. The routing
 * rules need that and only the author knows it.
 */
function parseClassify(rest: string[]): ParseResult {
  const changes: ClassifyChange[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;

    if (argument === "--json") {
      json = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);

    if (flag !== "--change" && flag !== "--rewrite") {
      return { kind: "error", message: `leglas classify does not take ${argument}.` };
    }

    const value = equals === -1 ? rest[(index += 1)] : argument.slice(equals + 1);

    if (value === undefined || value === "") {
      return { kind: "error", message: `${flag} needs a path, for example ${flag} package.json` };
    }

    changes.push({ path: value, kind: flag === "--change" ? "change" : "rewrite" });
  }

  if (changes.length === 0) {
    return {
      kind: "error",
      message:
        "leglas classify needs what the direction will touch, for example: " +
        "npx leglas classify --change package.json --rewrite src/theme.css",
    };
  }

  return { kind: "classify", changes, json };
}

/**
 * The agent command is one quoted argument so Leglas is the only thing that
 * splits it. Loose trailing words would reach watch with the prompt's quoting
 * already eaten by the shell.
 */
function parseWatch(rest: string[]): ParseResult {
  let run: string | undefined;
  let port: number | undefined;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;

    if (argument === "--json") {
      json = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);

    if (flag !== "--run" && flag !== "--port") {
      return { kind: "error", message: `leglas watch does not take ${argument}.` };
    }

    const value = equals === -1 ? rest[(index += 1)] : argument.slice(equals + 1);

    if (value === undefined || value === "") {
      return {
        kind: "error",
        message:
          flag === "--run"
            ? '--run needs an agent command, for example --run "claude -p {prompt}"'
            : "--port needs a value.",
      };
    }

    if (flag === "--run") {
      run = value;
      continue;
    }

    const parsed = parsePort(flag, value);

    if ("error" in parsed) return { kind: "error", message: parsed.error };
    port = parsed.port;
  }

  return { kind: "watch", run, port, json };
}

/**
 * No titles shares the rail, one shares a direction and two compare them, the
 * second on the right. `--stop` takes nothing that would start a share.
 */
function parseShare(rest: string[]): ParseResult {
  const titles: string[] = [];
  let reach: ShareReach = "open";
  let reachGiven = false;
  let tunnel: ShareTunnel | null = null;
  let stop = false;
  let port: number | null = null;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--stop") {
      stop = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);

    if (flag === "--reach" || flag === "--tunnel" || flag === "--port") {
      const raw = equals === -1 ? rest[(index += 1)] : argument.slice(equals + 1);

      if (raw === undefined || raw === "") {
        return { kind: "error", message: `${flag} needs a value.` };
      }

      if (flag === "--port") {
        const parsed = parsePort(flag, raw);

        if ("error" in parsed) return { kind: "error", message: parsed.error };
        port = parsed.port;
        continue;
      }

      if (flag === "--reach") {
        if (raw !== "open" && raw !== "listed") {
          return {
            kind: "error",
            message: `--reach is open or listed, received ${JSON.stringify(raw)}.`,
          };
        }

        reach = raw;
        reachGiven = true;
        continue;
      }

      const chosen = SHARE_TUNNELS.find((candidate) => candidate === raw);

      if (chosen === undefined) {
        return {
          kind: "error",
          message: `--tunnel is cloudflared, ngrok or none, received ${JSON.stringify(raw)}.`,
        };
      }

      tunnel = chosen;
      continue;
    }

    if (argument.startsWith("-")) {
      return { kind: "error", message: `leglas share does not take ${argument}.` };
    }

    titles.push(argument);
  }

  if (stop && (titles.length > 0 || reachGiven || tunnel !== null)) {
    return {
      kind: "error",
      message: "leglas share --stop ends the share; it takes no directions, reach or tunnel.",
    };
  }

  if (titles.length > 2) {
    return {
      kind: "error",
      message:
        "leglas share takes one direction to share alone, or two to compare. Name none to share the rail.",
    };
  }

  return { kind: "share", titles, reach, tunnel, stop, port, json };
}

export function parseArgs(argv: string[]): ParseResult {
  const [command] = argv;

  // Answered before any command reads its own arguments, so no command can
  // forget --help.
  if (
    command !== undefined &&
    !command.startsWith("-") &&
    argv.slice(1).some((argument) => argument === "--help" || argument === "-h")
  ) {
    return { kind: "help" };
  }

  if (argv[0] === "new") return parseNew(argv.slice(1));

  if (argv[0] === "watch") return parseWatch(argv.slice(1));

  if (argv[0] === "add") return parseAdd(argv.slice(1));

  if (argv[0] === "classify") return parseClassify(argv.slice(1));

  if (argv[0] === "init") {
    const rest = argv.slice(1);
    const unknown = rest.find((argument) => argument !== "--force" && argument !== "--json");

    if (unknown !== undefined) {
      return { kind: "error", message: `leglas init does not take ${unknown}.` };
    }

    return { kind: "init", force: rest.includes("--force"), json: rest.includes("--json") };
  }

  if (argv[0] === "keep") {
    const rest = argv.slice(1);
    let title: string | undefined;
    let to: string | undefined;
    let json = false;

    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]!;

      if (argument === "--json") {
        json = true;
        continue;
      }

      if (argument === "--to" || argument.startsWith("--to=")) {
        to = argument.includes("=") ? argument.split("=").slice(1).join("=") : rest[(index += 1)];

        if (to === undefined || to === "") {
          return {
            kind: "error",
            message: "--to needs a path, for example --to src/components/hero.tsx",
          };
        }

        continue;
      }

      if (argument.startsWith("-")) {
        return { kind: "error", message: `leglas keep does not take ${argument}.` };
      }

      if (title !== undefined) {
        return { kind: "error", message: "leglas keep takes one direction title." };
      }

      title = argument;
    }

    if (title === undefined) {
      return {
        kind: "error",
        message:
          'leglas keep needs a direction title, for example: npx leglas keep "Aurora" --to src/components/hero.tsx',
      };
    }

    if (to === undefined) {
      return {
        kind: "error",
        message: "leglas keep needs --to, the path the winner should live at.",
      };
    }

    return { kind: "keep", title, to, json };
  }

  if (argv[0] === "explore") {
    const rest = argv.slice(1);
    let surface: string | undefined;
    let count = 3;
    let basedOn: string | null = null;
    let json = false;
    let build = false;
    let brief: string | null = null;
    let port: number | null = null;

    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]!;

      if (argument === "--json") {
        json = true;
        continue;
      }

      if (argument === "--build") {
        build = true;
        continue;
      }

      if (argument === "--brief" || argument.startsWith("--brief=")) {
        const raw = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : rest[(index += 1)];

        if (raw === undefined || raw.trim() === "") {
          return {
            kind: "error",
            message: '--brief needs a description, for example --brief "A hero for a cooking app".',
          };
        }

        brief = raw;
        continue;
      }

      if (argument === "--port" || argument.startsWith("--port=")) {
        const raw = argument.includes("=") ? argument.split("=")[1] : rest[(index += 1)];

        if (raw === undefined || !/^\d+$/.test(raw)) {
          return { kind: "error", message: "--port needs a number, for example --port 4000." };
        }

        port = Number(raw);
        continue;
      }

      if (argument === "--count" || argument.startsWith("--count=")) {
        const raw = argument.includes("=") ? argument.split("=")[1] : rest[(index += 1)];

        if (raw === undefined || !/^\d+$/.test(raw)) {
          return { kind: "error", message: "--count needs a number, for example --count 6." };
        }

        count = Number(raw);
        continue;
      }

      if (argument === "--based-on" || argument.startsWith("--based-on=")) {
        const raw = argument.includes("=") ? argument.split("=")[1] : rest[(index += 1)];

        if (raw === undefined || raw === "") {
          return {
            kind: "error",
            message: '--based-on needs a direction title, for example --based-on "Aurora".',
          };
        }

        basedOn = raw;
        continue;
      }

      if (argument.startsWith("-")) {
        return { kind: "error", message: `leglas explore does not take ${argument}.` };
      }

      if (surface !== undefined) {
        return { kind: "error", message: "leglas explore takes one surface name." };
      }

      surface = argument;
    }

    if (surface === undefined) {
      return {
        kind: "error",
        message:
          "leglas explore needs a surface name, for example: npx leglas explore hero --count 6",
      };
    }

    // Variations have their direction to go on, so only a new set needs a brief.
    if (build && brief === null && basedOn === null) {
      return {
        kind: "error",
        message:
          'leglas explore --build needs a brief, for example: npx leglas explore hero --build --brief "A hero for a cooking app". To vary a direction instead, name it with --based-on "<title>".',
      };
    }

    if (!build && brief !== null) {
      return {
        kind: "error",
        message: "--brief goes with --build: add --build to have Leglas build the set.",
      };
    }

    return { kind: "explore", surface, count, basedOn, json, build, brief, port };
  }

  if (argv[0] === "requests") {
    const rest = argv.slice(1);
    const unknown = rest.find((argument) => argument !== "--json" && argument !== "--clear");

    if (unknown !== undefined) {
      return { kind: "error", message: `leglas requests does not take ${unknown}.` };
    }

    return { kind: "requests", json: rest.includes("--json"), clear: rest.includes("--clear") };
  }

  if (argv[0] === "log") {
    const rest = argv.slice(1);
    const flags = rest.filter((argument) => argument.startsWith("--"));
    const unknown = flags.find((flag) => flag !== "--json");

    if (unknown !== undefined) {
      return { kind: "error", message: `leglas log does not take ${unknown}.` };
    }

    const names = rest.filter((argument) => !argument.startsWith("--"));

    if (names.length > 1) {
      return { kind: "error", message: "leglas log takes one entry at most." };
    }

    return { kind: "log", entry: names[0] ?? null, json: flags.includes("--json") };
  }

  if (argv[0] === "list") {
    const rest = argv.slice(1);
    const unknown = rest.find((argument) => argument !== "--json");

    if (unknown !== undefined) {
      return { kind: "error", message: `leglas list does not take ${unknown}.` };
    }

    return { kind: "list", json: rest.includes("--json") };
  }

  // No "variant" alias: a variant is a version of a direction here, so `leglas
  // variant "Aurora"` would read as "the variant of Aurora" while meaning "show
  // me Aurora".
  if (argv[0] === "show") {
    const rest = argv.slice(1);
    let title: string | undefined;
    let json = false;
    let screenshot = false;
    let width: number | null = null;
    let port: number | null = null;

    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]!;

      if (argument === "--json") {
        json = true;
        continue;
      }

      if (argument === "--screenshot") {
        screenshot = true;
        continue;
      }

      if (
        argument === "--width" ||
        argument.startsWith("--width=") ||
        argument === "--port" ||
        argument.startsWith("--port=")
      ) {
        const equals = argument.indexOf("=");
        const flag = equals === -1 ? argument : argument.slice(0, equals);
        const raw = equals === -1 ? rest[(index += 1)] : argument.slice(equals + 1);

        if (raw === undefined || raw === "") {
          return { kind: "error", message: `${flag} needs a value.` };
        }

        if (flag === "--port") {
          const parsed = parsePort(flag, raw);

          if ("error" in parsed) return { kind: "error", message: parsed.error };
          port = parsed.port;
          continue;
        }

        if (!/^\d+$/.test(raw)) {
          return {
            kind: "error",
            message: `--width needs a number, received ${JSON.stringify(raw)}.`,
          };
        }

        width = Number(raw);

        if (width < MIN_SHOW_WIDTH || width > MAX_SHOW_WIDTH) {
          return {
            kind: "error",
            message: `--width must be between ${MIN_SHOW_WIDTH} and ${MAX_SHOW_WIDTH}, received ${width}.`,
          };
        }

        continue;
      }

      if (argument.startsWith("-")) {
        return { kind: "error", message: `leglas show does not take ${argument}.` };
      }

      if (title !== undefined) {
        return { kind: "error", message: "leglas show takes one direction title." };
      }

      title = argument;
    }

    if (title === undefined) {
      return {
        kind: "error",
        message:
          'leglas show needs a direction title, for example: npx leglas show "Aurora" --json',
      };
    }

    if (width !== null && !screenshot) {
      return { kind: "error", message: "leglas show --width needs --screenshot." };
    }

    if (port !== null && !screenshot) {
      return { kind: "error", message: "leglas show --port needs --screenshot." };
    }

    return { kind: "show", title, json, screenshot, width, port };
  }

  if (argv[0] === "share") return parseShare(argv.slice(1));

  const options: RunOptions = {
    port: undefined,
    userPort: undefined,
    configPath: undefined,
    open: true,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--help" || argument === "-h") return { kind: "help" };

    if (argument === "--version" || argument === "-v") return { kind: "version" };

    if (BOOLEAN_FLAGS.has(argument)) {
      if (argument === "--no-open") options.open = false;

      if (argument === "--json") options.json = true;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);

    if (!VALUE_FLAGS.has(flag)) {
      return {
        kind: "error",
        message: argument.startsWith("-")
          ? `Unknown flag ${argument}. Run leglas --help to see the options.`
          : `Unexpected argument ${JSON.stringify(argument)}. leglas takes flags only.`,
      };
    }

    let value: string | undefined;

    if (equals === -1) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }

    if (value === undefined || value === "" || value.startsWith("--")) {
      return { kind: "error", message: `${flag} needs a value.` };
    }

    if (flag === "--config") {
      options.configPath = value;
      continue;
    }

    const port = parsePort(flag, value);

    if ("error" in port) return { kind: "error", message: port.error };

    if (flag === "--port") options.port = port.port;
    else options.userPort = port.port;
  }

  return { kind: "run", options };
}
