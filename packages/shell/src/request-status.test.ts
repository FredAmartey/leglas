import { describe, expect, test } from "vitest";

import {
  requestStatusLine,
  type AgentOption,
  type AgentStatus,
  type RequestStatus,
} from "./request-status.js";

const idleAgent: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
};

const request = (id: string, status: RequestStatus["status"]): RequestStatus => ({
  id,
  title: "Aurora",
  status,
});

const option = (id: string, available = true): AgentOption => ({
  id,
  name: id === "claude" ? "Claude" : "Codex",
  available,
});

function decide({
  requests = [],
  agent = idleAgent,
  choice = null,
  available = [],
  dismissed = false,
}: {
  requests?: RequestStatus[];
  agent?: AgentStatus;
  choice?: string | null;
  available?: AgentOption[];
  dismissed?: boolean;
} = {}) {
  return requestStatusLine(requests, agent, choice, available, dismissed);
}

describe("requestStatusLine resting states", () => {
  test("offers detected agents before a request exists", () => {
    expect(
      decide({
        available: [option("codex", false), option("claude")],
      }),
    ).toEqual({ kind: "picker" });
  });

  test.each([
    { available: [] as AgentOption[] },
    { available: [option("claude", false)] },
  ])("returns the hint when no agent is detected: $available", ({ available }) => {
    expect(decide({ available })).toEqual({ kind: "hint" });
  });

  test("returns the hint after the picker has been dismissed", () => {
    expect(
      decide({
        available: [option("claude")],
        dismissed: true,
      }),
    ).toEqual({ kind: "hint" });
  });

  test("shows the chosen agent as ready by display name", () => {
    expect(
      decide({
        choice: "claude",
        available: [option("codex"), option("claude")],
      }),
    ).toEqual({ kind: "ready", name: "Claude" });
  });

  test("gives an existing custom choice a display name", () => {
    expect(
      decide({
        choice: "custom",
        available: [option("claude")],
      }),
    ).toEqual({ kind: "ready", name: "Custom" });
  });

  test("only applies dismissal while no agent is chosen", () => {
    expect(
      decide({
        choice: "claude",
        available: [option("claude")],
        dismissed: true,
      }),
    ).toEqual({ kind: "ready", name: "Claude" });
  });

  test("falls back to the hint when the chosen agent is no longer detected", () => {
    expect(
      decide({
        choice: "claude",
        available: [option("claude", false)],
      }),
    ).toEqual({ kind: "hint" });
  });
});

describe("requestStatusLine status priority", () => {
  test("shows running activity ahead of every lower-priority state", () => {
    expect(
      decide({
        requests: [
          request("failed", "failed"),
          request("picked-up", "picked-up"),
          request("queued", "queued"),
          request("running", "running"),
        ],
        agent: {
          attached: true,
          running: true,
          name: "Claude",
          activity: "editing src/Hero.tsx",
        },
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "Claude is on it: editing src/Hero.tsx",
      cancellable: true,
      failedId: null,
    });
  });

  test("falls back to the running agent name when there is no activity", () => {
    expect(
      decide({
        requests: [request("running", "running")],
        agent: { ...idleAgent, running: true, name: "Claude" },
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "Claude is on it",
      cancellable: true,
      failedId: null,
    });
  });

  test("treats a running request as active before the agent poll catches up", () => {
    expect(
      decide({
        requests: [request("running", "running")],
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "Your agent is on it",
      cancellable: true,
      failedId: null,
    });
  });

  test("uses singular copy for one queued request", () => {
    expect(
      decide({
        requests: [request("queued", "queued")],
        choice: "claude",
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "1 change queued for your agent",
      cancellable: false,
      failedId: null,
    });
  });

  test("counts queued requests ahead of picked-up, failed and attached states", () => {
    expect(
      decide({
        requests: [
          request("failed", "failed"),
          request("picked-up", "picked-up"),
          request("queued-1", "queued"),
          request("queued-2", "queued"),
        ],
        agent: { ...idleAgent, attached: true },
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "2 changes queued for your agent",
      cancellable: false,
      failedId: null,
    });
  });

  test("reports an external pickup ahead of a failed request", () => {
    expect(
      decide({
        requests: [request("failed", "failed"), request("picked-up", "picked-up")],
        agent: { ...idleAgent, attached: true },
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "Your agent is on it",
      cancellable: false,
      failedId: null,
    });
  });

  test("offers the most recent failure for retry", () => {
    expect(
      decide({
        requests: [request("older", "failed"), request("newer", "failed")],
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "That change failed. Try again?",
      cancellable: false,
      failedId: "newer",
    });
  });

  test("shows an attached agent listening ahead of the picker", () => {
    expect(
      decide({
        agent: { ...idleAgent, attached: true },
        available: [option("claude")],
      }),
    ).toEqual({
      kind: "status",
      text: "Your agent is listening",
      cancellable: false,
      failedId: null,
    });
  });
});
