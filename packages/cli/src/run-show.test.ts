import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { writeRenames, writeServerInfo } from "@leglas/server";

import { readLink } from "../../shell/src/link.js";

import type { JsonValue } from "./json.js";
import { runShow } from "./run-show.js";
import { addLocal, leglasServing } from "./test-helpers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-show-"));
}

const add = (cwd: string, title: string, url: string) =>
  addLocal(cwd, "--title", title, "--url", url);

type ShowEnvelope = {
  direction?: { title: string; interfaceUrl: string | null };
  error?: string;
  screenshot?: { hydration: { framework: string; message: string } | null };
};

type ShowOptions = Parameters<typeof runShow>[0];

/** `leglas show <title> --json`, with a screenshot when the options ask for one. */
async function show(
  cwd: string,
  options: Partial<ShowOptions> & { title: string },
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  const lines: string[] = [];

  const { exitCode } = await runShow(
    { json: true, screenshot: false, width: null, port: null, cwd, ...options },
    { log: (line) => lines.push(line), error: () => {}, fetch },
  );

  return {
    exitCode,
    lines,
    /** The envelope, under --json. */
    get envelope(): ShowEnvelope {
      return JSON.parse(lines[lines.length - 1] ?? "{}");
    },
  };
}

/** A running Leglas that answers health with this body, then the capture with that one. */
function capturing(health: JsonValue, capture: JsonValue, status = 200) {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(health))
    .mockResolvedValueOnce(Response.json(capture, { status }));
}

const aurora = async () => {
  const cwd = scratch();
  await add(cwd, "Aurora", "/?v-hero=aurora");

  return cwd;
};

const screenshot = { title: "Aurora", screenshot: true, port: 4321 } as const;

describe("runShow", () => {
  test("answers to the name the rail was renamed to, not just the config title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await writeRenames(cwd, { Cool: "Sunrise" });

    // The name a user says is the one their own interface showed them.
    const { exitCode, envelope } = await show(cwd, { title: "Sunrise" });

    expect(exitCode).toBe(0);
    expect(envelope.direction).toMatchObject({ title: "Cool" });
  });

  test("gives the address that opens the interface on a direction the running rail shows", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Warm", "/?v-hero=warm");
    await writeServerInfo(cwd, { port: 4321, url: "http://localhost:4321", pid: 1 });
    const fetch = leglasServing(cwd, ["Cool"]);

    const shown = async (title: string) =>
      (await show(cwd, { title }, fetch)).envelope.direction?.interfaceUrl;

    const address = await shown("Cool");

    expect(address).toEqual(expect.any(String));
    const opens = new URL(address ?? "");

    expect(`${opens.origin}${opens.pathname}`).toBe("http://localhost:4321/leglas");
    expect(readLink(opens.search)).toEqual({ direction: "Cool", compare: null });
    expect(await shown("Warm")).toBeNull();
  });

  test("a config title still wins over another direction's local nickname", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Warm", "/?v-hero=warm");
    await writeRenames(cwd, { Cool: "Warm" });

    const { exitCode, envelope } = await show(cwd, { title: "Warm" });

    expect(exitCode).toBe(0);
    expect(envelope.direction).toMatchObject({ title: "Warm" });
  });

  test("refuses a nickname two directions share rather than picking one", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Aurora", "/?v-hero=aurora");
    await writeRenames(cwd, { Cool: "Calm", Aurora: "Calm" });

    const { exitCode, envelope } = await show(cwd, { title: "Calm" });

    expect(exitCode).toBe(1);
    expect(String(envelope.error)).toContain("Cool, Aurora");
  });

  test("an unknown name says why the name it was given may not be a title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");

    const { exitCode, envelope } = await show(cwd, { title: "Nope" });

    expect(exitCode).toBe(1);
    // A renamed direction isn't listed under its given name, so pointing at
    // leglas list reads as "it's gone".
    expect(String(envelope.error)).toContain("Renaming one in the rail");
  });

  test("checks the running server and adds one screenshot to the JSON envelope", async () => {
    const fetch = capturing(
      { ok: true },
      {
        ok: true,
        file: ".leglas/captures/show/aurora-390.png",
        width: 390,
        height: 800,
        viewport: 390,
        errors: ["boom"],
        hydration: { framework: "React", message: "Minified React error #418" },
      },
    );

    const { exitCode, lines, envelope } = await show(
      await aurora(),
      { ...screenshot, width: 390 },
      fetch,
    );

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(envelope.screenshot).toEqual({
      file: ".leglas/captures/show/aurora-390.png",
      width: 390,
      height: 800,
      viewport: 390,
      errors: ["boom"],
      hydration: { framework: "React", message: "Minified React error #418" },
      cut: false,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4321/leglas/api/health");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      title: "Aurora",
      width: 390,
    });
    // Bounded, so a server that answers health and then stalls can't hold the
    // command.
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("human output names the PNG and each console error", async () => {
    const fetch = capturing(
      {},
      {
        file: ".leglas/captures/show/aurora-1440.png",
        width: 1440,
        height: 900,
        viewport: 1440,
        errors: ["first", "second"],
        hydration: { framework: "React", message: "Minified React error #418" },
        cut: true,
      },
    );

    const { lines } = await show(await aurora(), { ...screenshot, json: false }, fetch);

    expect(lines).toContain("  screenshot  .leglas/captures/show/aurora-1440.png");
    // A page taller than one capture says so, so the agent knows what it hasn't
    // seen.
    expect(lines).toContain(
      "              the top of the page only; it is taller than one capture",
    );
    expect(lines).toContain(
      "  hydration   React rebuilt the page in the browser after load; the served markup is not what is on screen",
    );
    expect(lines).toContain("              Minified React error #418");
    expect(lines.indexOf("              Minified React error #418")).toBeLessThan(
      lines.indexOf("  console     2 errors on load"),
    );
    expect(lines).toContain("  console     2 errors on load");
    expect(lines).toContain("    first");
    expect(lines).toContain("    second");
  });

  test("human output omits hydration lines when the server has no evidence", async () => {
    const fetch = capturing(
      {},
      {
        file: ".leglas/captures/show/aurora-1440.png",
        width: 1440,
        height: 900,
        viewport: 1440,
        errors: [],
      },
    );

    const { lines } = await show(await aurora(), { ...screenshot, json: false }, fetch);

    expect(lines.join("\n")).not.toContain("hydration");
    expect(lines.join("\n")).not.toContain("rebuilt the page in the browser");
  });

  test("reports a missing server and surfaces capture errors verbatim", async () => {
    const cwd = await aurora();
    // No record on disk, and nothing answering on the default port either.
    const refused = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

    const missing = await show(cwd, { ...screenshot, port: null }, refused);

    expect(refused.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4100/leglas/api/health");
    expect(missing.exitCode).toBe(1);
    expect(missing.envelope.error).toContain("Leglas is not running here");

    const failed = await show(
      cwd,
      screenshot,
      capturing({}, { ok: false, error: "No browser here." }, 503),
    );

    expect(failed.exitCode).toBe(1);
    expect(failed.envelope.error).toBe("No browser here.");
  });
});

describe("whose server a screenshot comes from", () => {
  test("a server serving another project is refused before anything is captured", async () => {
    const cwd = await aurora();

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ reachable: true, cwd: join(cwd, "..", "elsewhere") }));

    const { exitCode, envelope } = await show(cwd, screenshot, fetch);

    expect(exitCode).toBe(1);
    expect(String(envelope.error)).toContain("serves another project");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a server serving this project is accepted by its directory", async () => {
    const cwd = await aurora();

    const fetch = capturing(
      { reachable: true, cwd },
      {
        file: ".leglas/captures/show/aurora-1440.png",
        width: 1440,
        height: 900,
        viewport: 1440,
        errors: [],
      },
    );

    const { exitCode, envelope } = await show(cwd, screenshot, fetch);

    expect(exitCode).toBe(0);
    expect(envelope.screenshot?.hydration).toBeNull();
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(
      "http://127.0.0.1:4321/leglas/api/capture",
    );
  });
});

describe("capture response boundaries", () => {
  const capture = {
    file: ".leglas/captures/show/aurora.png",
    width: 390,
    height: 800,
    viewport: 390,
  };

  // A null reply is a failed capture, not a crash, whatever its status.
  test.each([
    { body: { ...capture, file: 4 }, status: 200 },
    { body: { ...capture, width: "390" }, status: 200 },
    { body: { ...capture, height: null }, status: 200 },
    { body: { ...capture, viewport: false }, status: 200 },
    { body: { error: 503 }, status: 503 },
    { body: null, status: 200 },
    { body: null, status: 503 },
  ])("rejects malformed capture fields: $body", async ({ body, status }) => {
    const { exitCode, envelope } = await show(
      await aurora(),
      screenshot,
      capturing({ cwd: 42 }, body, status),
    );

    expect(exitCode).toBe(1);
    expect(envelope.error).toBe("The direction could not be captured.");
  });

  test("keeps string diagnostics in order and ignores incomplete hydration evidence", async () => {
    const cwd = await aurora();

    const fetch = capturing(
      { cwd },
      {
        ...capture,
        errors: ["first", null, 1, "second"],
        hydration: { framework: "React", message: false },
        cut: "true",
      },
    );

    const { envelope } = await show(cwd, screenshot, fetch);

    expect(envelope.screenshot).toEqual({
      ...capture,
      errors: ["first", "second"],
      hydration: null,
      cut: false,
    });
  });

  test("a null health reply fails before requesting a capture", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(null));

    const { exitCode, envelope } = await show(await aurora(), screenshot, fetch);

    expect(exitCode).toBe(1);
    expect(envelope.error).toContain("Leglas is not running here");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
