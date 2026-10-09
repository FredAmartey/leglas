import { afterEach, describe, expect, test, vi } from "vitest";

import {
  cancelAgentRun,
  chooseAgent,
  chooseAgentEffort,
  dismissFailedRequest,
  readAgents,
  retryFailedRequest,
  type AgentsPayload,
} from "./agent-api.js";
import type { JsonValue } from "../json.js";

/** Answers every call with `body`, and records each one less its abort signal. */
function serve(body: JsonValue = { ok: true }, status = 200) {
  const calls: { input: string; init: RequestInit }[] = [];

  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const { signal: _signal, ...recorded } = init;
    calls.push({ input, init: recorded });

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("embedded agent API", () => {
  test("reads the complete agent picker state, freshly detected when the picker opens", async () => {
    const payload = {
      agents: [
        { id: "claude", name: "Claude", available: true, auth: "ok", efforts: ["low", "high"] },
        { id: "codex", name: "Codex", available: false, auth: "unknown", efforts: ["low", "high"] },
      ],
      choice: null,
      customRun: null,
      effort: null,
    };

    const calls = serve(payload);

    await expect(readAgents()).resolves.toEqual(payload);
    await readAgents(true);

    expect(calls).toEqual([
      { input: "/leglas/api/agents", init: {} },
      { input: "/leglas/api/agents?refresh=1", init: {} },
    ]);
  });

  test.each<[string, () => Promise<void>, string, Record<string, string | null> | null]>([
    ["the picked adapter", () => chooseAgent("claude"), "/leglas/api/agent", { agent: "claude" }],
    [
      "a custom adapter with its template",
      () => chooseAgent("custom", "aider --yes {prompt}"),
      "/leglas/api/agent",
      { agent: "custom", run: "aider --yes {prompt}" },
    ],
    [
      "an effort override",
      () => chooseAgentEffort("codex", "high"),
      "/leglas/api/agent",
      { agent: "codex", effort: "high" },
    ],
    [
      "a return to the agent's default effort",
      () => chooseAgentEffort("codex", null),
      "/leglas/api/agent",
      { agent: "codex", effort: null },
    ],
    [
      "a stop naming the request it knows",
      () => cancelAgentRun("request-3"),
      "/leglas/api/requests/cancel",
      { id: "request-3" },
    ],
    [
      "a stop of whatever is running",
      () => cancelAgentRun(null),
      "/leglas/api/requests/cancel",
      null,
    ],
    [
      "a retry of the failed id",
      () => retryFailedRequest("request-7"),
      "/leglas/api/requests/retry",
      { id: "request-7" },
    ],
    [
      "a dismissal of the failed id",
      () => dismissFailedRequest("request-7"),
      "/leglas/api/requests/dismiss",
      { id: "request-7" },
    ],
  ])("posts %s", async (_, write, path, body) => {
    const calls = serve();

    await write();

    expect(calls).toEqual([
      {
        input: path,
        init:
          body === null
            ? { method: "POST" }
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              },
      },
    ]);
  });

  test.each<[string, () => Promise<AgentsPayload | void>, number]>([
    ["agent detection", () => readAgents(true), 5_000],
    ["a local agent action", () => chooseAgent("claude"), 10_000],
  ])("stops waiting when %s never answers", async (_, call, deadline) => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      (_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    const assertion = expect(call()).rejects.toThrow("aborted");

    await vi.advanceTimersByTimeAsync(deadline);

    await assertion;
  });

  test("rejects a refused mutation so the caller can show a toast", async () => {
    serve({ ok: false, error: "refused" }, 400);

    await expect(chooseAgent("claude")).rejects.toThrow("Leglas refused the agent request.");
  });
});
