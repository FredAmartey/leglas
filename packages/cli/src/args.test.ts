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

  test("rejects a bare argument, since there are no positional commands yet", () => {
    const result = parseArgs(["start"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("start");
  });
});
