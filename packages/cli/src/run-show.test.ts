import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { writeRenames } from "@leglas/server";

import { runAdd } from "./run-previews.js";
import { runShow } from "./run-show.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-show-"));
}

function collect() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    deps: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
    lines,
    errors,
  };
}

const add = (cwd: string, title: string, url: string) =>
  runAdd(
    {
      preview: { title, url, note: undefined, tags: undefined, branch: undefined, file: undefined, basedOn: undefined, askedFor: undefined },
      json: true,
      cwd,
    },
    collect().deps,
  );

const envelope = (lines: string[]) => JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;

describe("runShow", () => {
  test("answers to the name the rail was renamed to, not just the config title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await writeRenames(cwd, { Cool: "Sunrise" });
    const { deps, lines } = collect();

    // The name a user says out loud is the one their own interface showed them.
    const outcome = await runShow(
      { title: "Sunrise", json: true, screenshot: false, width: null, port: null, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    const direction = envelope(lines)["direction"] as Record<string, unknown>;
    expect(direction["title"]).toBe("Cool");
  });

  test("a config title still wins over another direction's local nickname", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Warm", "/?v-hero=warm");
    await writeRenames(cwd, { Cool: "Warm" });
    const { deps, lines } = collect();

    const outcome = await runShow(
      { title: "Warm", json: true, screenshot: false, width: null, port: null, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    const direction = envelope(lines)["direction"] as Record<string, unknown>;
    expect(direction["title"]).toBe("Warm");
  });

  test("refuses a nickname two directions share rather than picking one", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    await add(cwd, "Aurora", "/?v-hero=aurora");
    await writeRenames(cwd, { Cool: "Calm", Aurora: "Calm" });
    const { deps, lines } = collect();

    const outcome = await runShow(
      { title: "Calm", json: true, screenshot: false, width: null, port: null, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(String(envelope(lines)["error"])).toContain("Cool, Aurora");
  });

  test("an unknown name says why the name it was given may not be a title", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v-hero=cool");
    const { deps, lines } = collect();

    const outcome = await runShow(
      { title: "Nope", json: true, screenshot: false, width: null, port: null, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(1);
    // Sending an agent to leglas list without this reads as "it is gone",
    // because a renamed direction is not listed under the name it was given.
    expect(String(envelope(lines)["error"])).toContain("Renaming one in the rail");
  });

  test("checks the running server and adds one screenshot to the JSON envelope", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const { deps, lines } = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            file: ".leglas/captures/show/aurora-390.png",
            width: 390,
            height: 800,
            viewport: 390,
            errors: ["boom"],
            hydration: { framework: "React", message: "Minified React error #418" },
          }),
          { status: 200 },
        ),
      );

    const outcome = await runShow(
      { title: "Aurora", json: true, screenshot: true, width: 390, port: 4321, cwd },
      { ...deps, fetch },
    );

    expect(outcome.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(envelope(lines)["screenshot"]).toEqual({
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
    // Bounded, so a server that answers health and then stalls cannot hold
    // the command for good.
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("human output names the PNG and each console error", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const { deps, lines } = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            file: ".leglas/captures/show/aurora-1440.png",
            width: 1440,
            height: 900,
            viewport: 1440,
            errors: ["first", "second"],
            hydration: { framework: "React", message: "Minified React error #418" },
            cut: true,
          }),
          { status: 200 },
        ),
      );

    await runShow(
      { title: "Aurora", json: false, screenshot: true, width: null, port: 4321, cwd },
      { ...deps, fetch },
    );

    expect(lines).toContain("  screenshot  .leglas/captures/show/aurora-1440.png");
    // A page taller than one capture says so, so the agent knows what it
    // has not seen.
    expect(lines).toContain("              the top of the page only; it is taller than one capture");
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
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const { deps, lines } = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            file: ".leglas/captures/show/aurora-1440.png",
            width: 1440,
            height: 900,
            viewport: 1440,
            errors: [],
          }),
          { status: 200 },
        ),
      );

    await runShow(
      { title: "Aurora", json: false, screenshot: true, width: null, port: 4321, cwd },
      { ...deps, fetch },
    );

    expect(lines.join("\n")).not.toContain("hydration");
    expect(lines.join("\n")).not.toContain("rebuilt the page in the browser");
  });

  test("reports a missing server and surfaces capture errors verbatim", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const absent = collect();
    // No record on disk, and nothing answering on the default port either.
    const refused = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const missing = await runShow(
      { title: "Aurora", json: true, screenshot: true, width: null, port: null, cwd },
      { ...absent.deps, fetch: refused },
    );
    expect(refused.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4100/leglas/api/health");
    expect(missing.exitCode).toBe(1);
    expect(envelope(absent.lines)["error"]).toContain("Leglas is not running here");

    const unavailable = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "No browser here." }), { status: 503 }),
      );
    const failed = await runShow(
      { title: "Aurora", json: true, screenshot: true, width: null, port: 4321, cwd },
      { ...unavailable.deps, fetch },
    );
    expect(failed.exitCode).toBe(1);
    expect(envelope(unavailable.lines)["error"]).toBe("No browser here.");
  });
});

describe("whose server a screenshot comes from", () => {
  test("a server serving another project is refused before anything is captured", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const { deps, lines } = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reachable: true, cwd: join(cwd, "..", "elsewhere") }), { status: 200 }),
      );

    const outcome = await runShow(
      { title: "Aurora", json: true, screenshot: true, width: null, port: 4321, cwd },
      { ...deps, fetch },
    );

    expect(outcome.exitCode).toBe(1);
    expect(String(envelope(lines)["error"])).toContain("serves another project");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a server serving this project is accepted by its directory", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v-hero=aurora");
    const { deps, lines } = collect();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ reachable: true, cwd }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ file: ".leglas/captures/show/aurora-1440.png", width: 1440, height: 900, viewport: 1440, errors: [] }),
          { status: 200 },
        ),
      );

    const outcome = await runShow(
      { title: "Aurora", json: true, screenshot: true, width: null, port: 4321, cwd },
      { ...deps, fetch },
    );

    expect(outcome.exitCode).toBe(0);
    expect((envelope(lines)["screenshot"] as Record<string, unknown>)["hydration"]).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
