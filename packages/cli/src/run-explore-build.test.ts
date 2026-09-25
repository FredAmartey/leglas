import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { runExploreBuild } from "./run-explore-build.js";

type Slot = {
  key: string;
  title: string;
  state: string;
  fixed: boolean;
  failure: { message: string } | null;
};

function job(state: string, slots: Slot[]) {
  return {
    id: "gen-1",
    state,
    error: null,
    startedAt: 1_000,
    endedAt: state === "done" ? 43_000 : null,
    slots,
  };
}

const slot = (title: string, state: string, extra: Partial<Slot> = {}): Slot => ({
  key: `hero-${title.toLowerCase()}`,
  title,
  state,
  fixed: false,
  failure: null,
  ...extra,
});

/** A running Leglas that answers health, accepts the start and then reports the job in the given order. */
function leglas(start: { status: number; body: object }, snapshots: object[]) {
  let next = 0;

  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);

    if (url.endsWith("/health")) return new Response("{}", { status: 200 });

    if (init?.method === "POST")
      return new Response(JSON.stringify(start.body), { status: start.status });
    const snapshot = snapshots[Math.min(next, snapshots.length - 1)];
    next += 1;

    return new Response(JSON.stringify({ ok: true, jobs: [snapshot] }), { status: 200 });
  });
}

function run(
  fetch: typeof globalThis.fetch,
  json = false,
  ask: { brief: string; basedOn: string | null } = {
    brief: "A hero for a cooking app",
    basedOn: null,
  },
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "leglas-explore-build-"));

  const outcome = runExploreBuild(
    { surface: "hero", ...ask, count: 3, json, cwd, port: 4321 },
    {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      fetch,
      sleep: async () => {},
    },
  );

  return { outcome, lines, errors };
}

describe("leglas explore --build", () => {
  test("reports each direction as it lands and exits 0 when all are ready", async () => {
    const fetch = leglas({ status: 202, body: { ok: true, job: job("planning", []) } }, [
      job("building", [
        slot("Ledger", "building"),
        slot("Steam", "building"),
        slot("Dial", "building"),
      ]),
      job("building", [
        slot("Ledger", "ready"),
        slot("Steam", "checking"),
        slot("Dial", "building"),
      ]),
      job("done", [
        slot("Ledger", "ready"),
        slot("Steam", "ready", { fixed: true }),
        slot("Dial", "ready"),
      ]),
    ]);

    const { outcome, lines } = run(fetch);

    expect((await outcome).exitCode).toBe(0);
    expect(lines).toEqual([
      "Planning 3 directions for the hero…",
      "On the rail: Ledger, Steam, Dial. Building them now.",
      "Ready: Ledger",
      "Ready: Steam (its first version did not render; fixed)",
      "Ready: Dial",
      "3 of 3 directions ready in 42 s. Compare them in the interface, or keep one with leglas keep.",
    ]);
  });

  test("asks for variations of a direction by its title, with no brief", async () => {
    const fetch = leglas({ status: 202, body: { ok: true, job: job("planning", []) } }, [
      job("done", [slot("Warm", "ready")]),
    ]);

    const { outcome, lines } = run(fetch, false, { brief: "", basedOn: "Menu" });

    expect((await outcome).exitCode).toBe(0);
    expect(lines[0]).toBe("Planning 3 variations of Menu…");

    const start = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(start?.[1]?.body))).toEqual({
      surface: "hero",
      brief: "",
      count: 3,
      basedOn: "Menu",
    });
  });

  test("exits 1 and says why when a direction fails", async () => {
    const failure = { message: "The build took longer than 5 minutes, so Leglas stopped it." };

    const fetch = leglas({ status: 202, body: { ok: true, job: job("planning", []) } }, [
      job("done", [slot("Ledger", "ready"), slot("Dial", "failed", { failure })]),
    ]);

    const { outcome, lines } = run(fetch);

    expect((await outcome).exitCode).toBe(1);
    expect(lines).toContain(`Failed: Dial. ${failure.message}`);
  });

  test("passes a refusal through word for word", async () => {
    const error =
      "Building directions runs on Claude for now. Choose Claude as the agent to use it.";

    const { outcome, errors } = run(leglas({ status: 422, body: { ok: false, error } }, []));

    expect((await outcome).exitCode).toBe(1);
    expect(errors).toEqual([error]);
  });

  test("prints one JSON envelope for an agent", async () => {
    const done = job("done", [slot("Ledger", "ready")]);

    const { outcome, lines } = run(
      leglas({ status: 202, body: { ok: true, job: job("planning", []) } }, [done]),
      true,
    );

    expect((await outcome).exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      ok: true,
      job: { id: "gen-1", state: "done" },
    });
  });
});
