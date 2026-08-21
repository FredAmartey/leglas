import { describe, expect, test } from "vitest";

import {
  cancelAgentRun,
  chooseAgent,
  chooseAgentEffort,
  dismissFailedRequest,
  readAgents,
  retryFailedRequest,
  type AgentFetcher,
} from "./agent-api.js";

function recorder(body: unknown = { ok: true }, status = 200) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher: AgentFetcher = async (input, init) => {
    calls.push({ input, ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetcher };
}

describe("embedded agent API", () => {
  test("reads the complete agent picker state", async () => {
    const payload = {
      agents: [
        { id: "claude", name: "Claude", available: true, auth: "ok", efforts: ["low", "high"] },
        { id: "codex", name: "Codex", available: false, auth: "unknown", efforts: ["low", "high"] },
      ],
      choice: null,
      customRun: null,
      effort: null,
    };
    const recorded = recorder(payload);

    await expect(readAgents(false, recorded.fetcher)).resolves.toEqual(payload);
    expect(recorded.calls).toEqual([{ input: "/leglas/api/agents" }]);
  });

  test("can ask for a fresh detection when the picker opens", async () => {
    const recorded = recorder({ agents: [], choice: null, customRun: null, effort: null });

    await readAgents(true, recorded.fetcher);

    expect(recorded.calls).toEqual([{ input: "/leglas/api/agents?refresh=1" }]);
  });

  test("posts the picked adapter as JSON, with the template when custom", async () => {
    const recorded = recorder();

    await chooseAgent("custom", "aider --yes {prompt}", recorded.fetcher);
    expect(recorded.calls[0]).toEqual({
      input: "/leglas/api/agent",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "custom", run: "aider --yes {prompt}" }),
      },
    });
    recorded.calls.length = 0;

    await chooseAgent("claude", undefined, recorded.fetcher);

    expect(recorded.calls).toEqual([
      {
        input: "/leglas/api/agent",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "claude" }),
        },
      },
    ]);
  });

  test("saves an effort override or returns to the agent default", async () => {
    const recorded = recorder();

    await chooseAgentEffort("codex", "high", recorded.fetcher);
    await chooseAgentEffort("codex", null, recorded.fetcher);

    expect(recorded.calls.map((call) => call.init?.body)).toEqual([
      JSON.stringify({ agent: "codex", effort: "high" }),
      JSON.stringify({ agent: "codex", effort: null }),
    ]);
  });

  test("names the request being stopped when it knows one", async () => {
    const recorded = recorder();

    await cancelAgentRun("request-3", recorded.fetcher);

    expect(recorded.calls).toEqual([
      {
        input: "/leglas/api/requests/cancel",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "request-3" }),
        },
      },
    ]);
  });

  test("wires cancellation to the running-request endpoint", async () => {
    const recorded = recorder({ ok: true, cancelled: true });

    await cancelAgentRun(null, recorded.fetcher);

    expect(recorded.calls).toEqual([
      {
        input: "/leglas/api/requests/cancel",
        init: { method: "POST" },
      },
    ]);
  });

  test("posts the failed id when retrying", async () => {
    const recorded = recorder();

    await retryFailedRequest("request-7", recorded.fetcher);

    expect(recorded.calls).toEqual([
      {
        input: "/leglas/api/requests/retry",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "request-7" }),
        },
      },
    ]);
  });

  test("posts the failed id when dismissing", async () => {
    const recorded = recorder();

    await dismissFailedRequest("request-7", recorded.fetcher);

    expect(recorded.calls).toEqual([
      {
        input: "/leglas/api/requests/dismiss",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "request-7" }),
        },
      },
    ]);
  });

  test("rejects a refused mutation so the caller can show a toast", async () => {
    const recorded = recorder({ ok: false, error: "refused" }, 400);

    await expect(chooseAgent("claude", undefined, recorded.fetcher)).rejects.toThrow(
      "Leglas refused the agent request.",
    );
  });
});
