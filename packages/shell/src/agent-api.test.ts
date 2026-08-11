import { describe, expect, test } from "vitest";

import {
  cancelAgentRun,
  chooseAgent,
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
        { id: "claude", name: "Claude", available: true },
        { id: "codex", name: "Codex", available: false },
      ],
      choice: null,
      customRun: null,
    };
    const recorded = recorder(payload);

    await expect(readAgents(recorded.fetcher)).resolves.toEqual(payload);
    expect(recorded.calls).toEqual([{ input: "/leglas/api/agents" }]);
  });

  test("posts the picked adapter as JSON", async () => {
    const recorded = recorder();

    await chooseAgent("claude", recorded.fetcher);

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

  test("wires cancellation to the running-request endpoint", async () => {
    const recorded = recorder({ ok: true, cancelled: true });

    await cancelAgentRun(recorded.fetcher);

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

  test("rejects a refused mutation so the caller can show a toast", async () => {
    const recorded = recorder({ ok: false, error: "refused" }, 400);

    await expect(chooseAgent("claude", recorded.fetcher)).rejects.toThrow(
      "Leglas refused the agent request.",
    );
  });
});
