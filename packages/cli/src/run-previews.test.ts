import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runAdd, runRequests } from "./run-previews.js";

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

const preview = (over: Record<string, unknown>) => ({
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
    const written = JSON.parse(readFileSync(join(cwd, ".leglas/previews.json"), "utf8")) as {
      previews: { title: string; basedOn?: string }[];
    };
    expect(written.previews.find((entry) => entry.title === "Dusk")?.basedOn).toBe("Meridian");
  });
});

describe("runAdd with --json", () => {
  test("includes a restart note for file previews", async () => {
    const output = collect();

    await runAdd({ preview: preview({ file: ".leglas/pages/x.html", url: undefined }), json: true, cwd: scratch() }, output.deps);

    expect(JSON.parse(output.lines[0] ?? "{}").note).toMatch(/Restart Leglas/);
  });

  test("includes a live-update note for url previews", async () => {
    const output = collect();

    await runAdd({ preview: preview({}), json: true, cwd: scratch() }, output.deps);

    expect(JSON.parse(output.lines[0] ?? "{}").note).toMatch(/within seconds/);
  });
});

describe("runRequests", () => {
  test("collects requests and includes id and status in the envelope", async () => {
    const cwd = scratch();
    const { appendRequest, readRequests } = await import("@leglas/server");
    await appendRequest(cwd, { title: "X", url: "/", intent: "warmer", target: null, prompt: "prompt" });
    const output = collect();
    await runRequests({ json: true, clear: false, cwd }, output.deps);
    expect(JSON.parse(output.lines[0] ?? "{}").requests[0]).toMatchObject({ id: expect.any(String), status: "picked-up" });
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
