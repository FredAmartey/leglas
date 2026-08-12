import { describe, expect, test } from "vitest";

import {
  composerAgent,
  formatElapsed,
  requestCard,
  type AgentOption,
  type AgentStatus,
  type RequestStatus,
} from "./request-status.js";

const idleAgent: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
  startedAt: null,
};

const request = (id: string, status: RequestStatus["status"], title = "Aurora"): RequestStatus => ({
  id,
  title,
  status,
});

const option = (id: string, available = true): AgentOption => ({
  id,
  name: id === "claude" ? "Claude" : "Codex",
  available,
});

describe("composerAgent", () => {
  test("offers the chooser while agents are detected and none is chosen", () => {
    expect(composerAgent(null, [option("codex", false), option("claude")], false)).toEqual({
      kind: "choose",
    });
  });

  test.each([[[] as AgentOption[]], [[option("claude", false)]]])(
    "disappears when no agent is detected: %j",
    (available) => {
      expect(composerAgent(null, available, false)).toEqual({ kind: "none" });
    },
  );

  test("wears the chosen agent's name", () => {
    expect(composerAgent("claude", [option("codex"), option("claude")], false)).toEqual({
      kind: "chosen",
      id: "claude",
      name: "Claude",
    });
  });

  test("gives an existing custom choice a display name", () => {
    expect(composerAgent("custom", [option("claude")], false)).toEqual({
      kind: "chosen",
      id: "custom",
      name: "Custom",
    });
  });

  test("shows manual after the chooser was declined", () => {
    expect(composerAgent(null, [option("claude")], true)).toEqual({ kind: "manual" });
  });

  test("only applies dismissal while no agent is chosen", () => {
    expect(composerAgent("claude", [option("claude")], true)).toEqual({
      kind: "chosen",
      id: "claude",
      name: "Claude",
    });
  });

  test("drops a chosen agent whose binary is no longer detected", () => {
    expect(composerAgent("claude", [option("claude", false)], false)).toEqual({ kind: "none" });
    expect(composerAgent("claude", [option("claude", false), option("codex")], false)).toEqual({
      kind: "choose",
    });
  });
});

describe("requestCard", () => {
  test("shows the run ahead of every lower-priority state", () => {
    expect(
      requestCard(
        [
          request("failed", "failed"),
          request("picked-up", "picked-up"),
          request("queued", "queued"),
          request("running", "running", "Warm serif"),
        ],
        {
          attached: true,
          running: true,
          name: "Claude",
          activity: "editing src/Hero.tsx",
          startedAt: 1700000000000,
        },
        true,
      ),
    ).toEqual({
      kind: "running",
      name: "Claude",
      activity: "editing src/Hero.tsx",
      startedAt: 1700000000000,
      title: "Warm serif",
    });
  });

  test("treats a running request as active before the agent poll catches up", () => {
    expect(requestCard([request("running", "running")], idleAgent, true)).toEqual({
      kind: "running",
      name: "Your agent",
      activity: null,
      startedAt: null,
      title: "Aurora",
    });
  });

  test("counts queued requests ahead of picked-up and failed states", () => {
    expect(
      requestCard(
        [
          request("failed", "failed"),
          request("picked-up", "picked-up"),
          request("queued-1", "queued"),
          request("queued-2", "queued"),
        ],
        { ...idleAgent, attached: true },
        true,
      ),
    ).toEqual({ kind: "queued", count: 2, attended: true });
  });

  test("says when nothing will drain the queue", () => {
    expect(requestCard([request("queued", "queued")], idleAgent, false)).toEqual({
      kind: "queued",
      count: 1,
      attended: false,
    });
  });

  test("reports an external pickup ahead of a failed request", () => {
    expect(
      requestCard(
        [request("failed", "failed"), request("picked-up", "picked-up")],
        { ...idleAgent, attached: true },
        true,
      ),
    ).toEqual({ kind: "picked-up" });
  });

  test("offers the most recent failure with its title", () => {
    expect(
      requestCard(
        [request("older", "failed"), request("newer", "failed", "Dark grotesk")],
        idleAgent,
        true,
      ),
    ).toEqual({ kind: "failed", id: "newer", title: "Dark grotesk" });
  });

  test("stays empty while the queue is empty", () => {
    expect(requestCard([], { ...idleAgent, attached: true }, true)).toBeNull();
  });
});

describe("formatElapsed", () => {
  test.each([
    [0, "0s"],
    [-2000, "0s"],
    [12_400, "12s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [65_000, "1m 05s"],
    [754_000, "12m 34s"],
  ])("%d ms reads as %s", (milliseconds, expected) => {
    expect(formatElapsed(milliseconds)).toBe(expected);
  });
});
