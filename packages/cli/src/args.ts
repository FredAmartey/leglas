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
  url: string;
  note: string | undefined;
  tags: string[] | undefined;
};

export type ParseResult =
  | { kind: "run"; options: RunOptions }
  | { kind: "new"; surface: string; print: boolean }
  | { kind: "add"; preview: AddPreview; json: boolean }
  | { kind: "list"; json: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const VALUE_FLAGS = new Set(["--port", "--user-port", "--config"]);
const BOOLEAN_FLAGS = new Set(["--no-open", "--json"]);

function parsePort(flag: string, raw: string): number | { error: string } {
  if (!/^\d+$/.test(raw)) {
    return { error: `${flag} needs a number, received ${JSON.stringify(raw)}.` };
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    return { error: `${flag} must be between 1 and 65535, received ${port}.` };
  }
  return port;
}

/**
 * Hand-rolled rather than a dependency: the surface is five flags, and an
 * unknown flag must be an error rather than silently ignored, which is the
 * behaviour most argument libraries get wrong by default.
 */
function parseNew(rest: string[]): ParseResult {
  let surface: string | undefined;
  let print = false;

  for (const argument of rest) {
    if (argument === "--print") {
      print = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument.startsWith("-")) {
      return { kind: "error", message: `leglas new does not take ${argument}.` };
    }
    if (surface !== undefined) {
      return { kind: "error", message: `leglas new takes one surface name, received ${JSON.stringify(argument)} as well.` };
    }
    surface = argument;
  }

  if (surface === undefined) {
    return {
      kind: "error",
      message: "leglas new needs a surface name, for example: leglas new hero",
    };
  }
  return { kind: "new", surface, print };
}

function parseAdd(rest: string[]): ParseResult {
  let title: string | undefined;
  let url: string | undefined;
  let note: string | undefined;
  const tags: string[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] as string;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { kind: "help" };

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    let value: string | undefined;
    if (equals === -1) {
      value = rest[index + 1];
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }

    if (!["--title", "--url", "--note", "--tag"].includes(flag)) {
      return { kind: "error", message: `leglas add does not take ${flag}.` };
    }
    if (value === undefined || value === "") {
      return { kind: "error", message: `${flag} needs a value.` };
    }

    if (flag === "--title") title = value;
    else if (flag === "--url") url = value;
    else if (flag === "--note") note = value;
    else tags.push(value);
  }

  if (title === undefined) {
    return { kind: "error", message: "leglas add needs --title, which is how the preview is identified." };
  }
  if (url === undefined) {
    return { kind: "error", message: "leglas add needs --url, for example --url '/?v-hero=aurora'." };
  }

  return {
    kind: "add",
    preview: { title, url, note, tags: tags.length > 0 ? tags : undefined },
    json,
  };
}

export function parseArgs(argv: string[]): ParseResult {
  if (argv[0] === "new") return parseNew(argv.slice(1));
  if (argv[0] === "add") return parseAdd(argv.slice(1));
  if (argv[0] === "list") {
    const rest = argv.slice(1);
    const unknown = rest.find((argument) => argument !== "--json");
    if (unknown !== undefined) {
      return { kind: "error", message: `leglas list does not take ${unknown}.` };
    }
    return { kind: "list", json: rest.includes("--json") };
  }

  const options: RunOptions = {
    port: undefined,
    userPort: undefined,
    configPath: undefined,
    open: true,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

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
    if (typeof port !== "number") return { kind: "error", message: port.error };
    if (flag === "--port") options.port = port;
    else options.userPort = port;
  }

  return { kind: "run", options };
}
