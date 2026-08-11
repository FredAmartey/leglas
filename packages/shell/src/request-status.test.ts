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

describe("requestStatusLine picker", () => {
  test.each(["queued", "picked-up", "failed"] as const)(
    "offers detected agents while a %s request is outstanding",
    (status) => {
      expect(
        decide({
          requests: [request("request-1", status)],
          available: [option("codex", false), option("claude")],
        }),
      ).toEqual({ kind: "picker" });
    },
  );

  test("does not offer a picker after an agent has been chosen", () => {
    expect(
      decide({
        requests: [request("request-1", "queued")],
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

  test("does not offer a picker when no detected agent is available", () => {
    expect(
      decide({
        requests: [request("request-1", "queued")],
        available: [option("claude", false)],
      }),
    ).toEqual({
      kind: "status",
      text: "1 change queued for your agent",
      cancellable: false,
      failedId: null,
    });
  });

  test("waits for an outstanding request before offering the picker", () => {
    expect(decide({ available: [option("claude")] })).toEqual({ kind: "hint" });
  });

  test("does not offer a picker after it has been dismissed", () => {
    expect(
      decide({
        requests: [request("request-1", "queued")],
        available: [option("claude")],
        dismissed: true,
      }),
    ).toEqual({
      kind: "status",
      text: "1 change queued for your agent",
      cancellable: false,
      failedId: null,
    });
  });
});

describe("requestStatusLine status priority", () => {
  test("shows running activity ahead of every queued state", () => {
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
        choice: "claude",
      }),
    ).toEqual({
      kind: "status",
      text: "Claude is on it — editing src/Hero.tsx",
      cancellable: true,
      failedId: null,
    });
  });

  test("falls back to the running agent name when there is no activity", () => {
    expect(
      decide({
        requests: [request("running", "running")],
        agent: { ...idleAgent, running: true, name: "Claude" },
        choice: "claude",
      }),
    ).toEqual({
      kind: "status",
      text: "Claude is on it",
      cancellable: true,
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
      }),
    ).toEqual({
      kind: "status",
      text: "That change failed — try again?",
      cancellable: false,
      failedId: "newer",
    });
  });

  test("shows an attached agent listening while idle", () => {
    expect(decide({ agent: { ...idleAgent, attached: true } })).toEqual({
      kind: "status",
      text: "Your agent is listening",
      cancellable: false,
      failedId: null,
    });
  });

  test("returns the standing hint when no live state supersedes it", () => {
    expect(decide()).toEqual({ kind: "hint" });
  });
});
