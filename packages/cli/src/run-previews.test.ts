import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeServerInfo } from "@leglas/server";
import { describe, expect, test, vi } from "vitest";

import { readLink } from "../../shell/src/link.js";

import { leglasServing } from "./test-helpers.js";

import type { AddPreview } from "./args.js";

import { runAdd, runList, runRequests } from "./run-previews.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-add-"));
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

const preview = (over: Partial<AddPreview>) => ({
  title: "X",
  url: "/?v-hero=x",
  note: undefined,
  tags: undefined,
  branch: undefined,
  file: undefined,
  basedOn: undefined,
  askedFor: undefined,
  ...over,
});

describe("runAdd with --based-on", () => {
  test("refuses a direction that is not registered, since that is a typo", async () => {
    const cwd = scratch();
    const { deps, errors } = collect();

    const outcome = await runAdd(
      { preview: preview({ title: "Dusk", basedOn: "Meridian" }), json: false, cwd },
      deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(errors.join(" ")).toContain("Meridian");
  });

  test("records the parent when it exists, and it survives the round trip", async () => {
    const cwd = scratch();
    const { deps } = collect();
    await runAdd(
      { preview: preview({ title: "Meridian", url: "/?v-hero=meridian" }), json: false, cwd },
      deps,
    );

    const outcome = await runAdd(
      {
        preview: preview({ title: "Dusk", url: "/?v-hero=dusk", basedOn: "Meridian" }),
        json: false,
        cwd,
      },
      deps,
    );

    expect(outcome.exitCode).toBe(0);

    const written: { previews: { title: string; basedOn?: string }[] } = JSON.parse(
      readFileSync(join(cwd, ".leglas/previews.json"), "utf8"),
    );

    expect(written.previews.find((entry) => entry.title === "Dusk")?.basedOn).toBe("Meridian");
  });
});

describe("runAdd with --json", () => {
  test("includes a restart note for file previews", async () => {
    const output = collect();

    await runAdd(
      {
        preview: preview({ file: ".leglas/pages/x.html", url: undefined }),
        json: true,
        cwd: scratch(),
      },
      output.deps,
    );

    expect(JSON.parse(output.lines[0] ?? "{}").note).toMatch(/Restart Leglas/);
  });

  test("includes a live-update note for url previews", async () => {
    const output = collect();

    await runAdd({ preview: preview({}), json: true, cwd: scratch() }, output.deps);

    expect(JSON.parse(output.lines[0] ?? "{}").note).toMatch(/within seconds/);
  });
});

describe("the address of the running interface", () => {
  test("add and list give one that opens on the direction, for this project's Leglas", async () => {
    const cwd = scratch();
    await writeServerInfo(cwd, { port: 4321, url: "http://localhost:4321", pid: 1 });
    const fetch = leglasServing(cwd, ["App", "Night sky"]);

    const added = collect();
    await runAdd(
      { preview: preview({ title: "Night sky" }), json: true, cwd },
      { ...added.deps, fetch },
    );
    const listed = collect();
    await runList({ json: true, cwd }, { ...listed.deps, fetch });

    const opens = new URL(JSON.parse(added.lines[0] ?? "{}").interfaceUrl);

    expect(`${opens.origin}${opens.pathname}`).toBe("http://localhost:4321/leglas");
    expect(readLink(opens.search)).toEqual({ direction: "Night sky", compare: null });

    const previews: { title: string; interfaceUrl: string }[] = JSON.parse(
      listed.lines[0] ?? "{}",
    ).previews;

    expect(previews.find((entry) => entry.title === "Night sky")?.interfaceUrl).toBe(opens.href);
  });

  test("is left out, and nothing is asked, with no Leglas recorded", async () => {
    const cwd = scratch();
    const fetch = vi.fn<typeof globalThis.fetch>();

    const added = collect();
    await runAdd({ preview: preview({}), json: true, cwd }, { ...added.deps, fetch });
    const listed = collect();
    await runList({ json: true, cwd }, { ...listed.deps, fetch });

    expect(JSON.parse(added.lines[0] ?? "{}")).not.toHaveProperty("interfaceUrl");
    expect(JSON.parse(listed.lines[0] ?? "{}").previews[0].interfaceUrl).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("is left out when the recorded port serves another project", async () => {
    const cwd = scratch();
    await writeServerInfo(cwd, { port: 4321, url: "http://localhost:4321", pid: 1 });

    const added = collect();
    await runAdd(
      { preview: preview({}), json: true, cwd },
      { ...added.deps, fetch: leglasServing(scratch(), ["X"]) },
    );

    expect(JSON.parse(added.lines[0] ?? "{}")).not.toHaveProperty("interfaceUrl");
  });

  // A branch or file direction added while Leglas runs reaches its rail only
  // after a restart.
  test("is left out for a direction the running rail doesn't show yet", async () => {
    const cwd = scratch();
    await writeServerInfo(cwd, { port: 4321, url: "http://localhost:4321", pid: 1 });
    const fetch = leglasServing(cwd, ["App"]);

    const added = collect();
    await runAdd(
      { preview: preview({ title: "On a branch", branch: "aurora" }), json: true, cwd },
      { ...added.deps, fetch },
    );
    const listed = collect();
    await runList({ json: true, cwd }, { ...listed.deps, fetch });

    const previews: { title: string; interfaceUrl: string | null }[] = JSON.parse(
      listed.lines[0] ?? "{}",
    ).previews;

    expect(JSON.parse(added.lines[0] ?? "{}")).toMatchObject({ ok: true, added: "On a branch" });
    expect(JSON.parse(added.lines[0] ?? "{}")).not.toHaveProperty("interfaceUrl");
    expect(previews.find((entry) => entry.title === "On a branch")?.interfaceUrl).toBeNull();
    expect(previews.find((entry) => entry.title === "App")?.interfaceUrl).toEqual(
      expect.any(String),
    );
  });
});

describe("runRequests", () => {
  test("collects requests and includes id and status in the envelope", async () => {
    const cwd = scratch();
    const { appendRequest, readRequests } = await import("@leglas/server");
    await appendRequest(cwd, {
      title: "X",
      url: "/",
      intent: "warmer",
      target: null,
      prompt: "prompt",
    });
    const output = collect();
    await runRequests({ json: true, clear: false, cwd }, output.deps);
    expect(JSON.parse(output.lines[0] ?? "{}").requests[0]).toMatchObject({
      id: expect.any(String),
      status: "picked-up",
    });
    expect((await readRequests(cwd))[0]?.status).toBe("picked-up");
  });

  test("clear drops collected work and says what is still waiting", async () => {
    const cwd = scratch();
    const { appendRequest, readRequests } = await import("@leglas/server");
    const request = { title: "X", url: "/", intent: "warmer", target: null, prompt: "prompt" };
    await appendRequest(cwd, request);
    await runRequests({ json: false, clear: false, cwd }, collect().deps);
    await appendRequest(cwd, { ...request, intent: "and darker" });

    const output = collect();
    await runRequests({ json: true, clear: true, cwd }, output.deps);

    expect(JSON.parse(output.lines[0] ?? "{}")).toMatchObject({ cleared: 1, pending: 1 });
    expect((await readRequests(cwd))[0]).toMatchObject({ intent: "and darker" });
  });
});
