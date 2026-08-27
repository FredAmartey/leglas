import { describe, expect, test } from "vitest";

import {
  changingRequestTitles,
  composerAgent,
  formatElapsed,
  notesAwaitingChange,
  requestCard,
  waitingLabel,
  workingRequestTitles,
  type AgentOption,
  type AgentStatus,
  type RequestFailure,
  type RequestStatus,
} from "./request-status.js";

const idleAgent: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
  startedAt: null,
};

const request = (
  id: string,
  status: RequestStatus["status"],
  title = "Aurora",
  failure: RequestFailure | null = null,
): RequestStatus => ({
  id,
  title,
  status,
  failure,
});

const option = (id: string, available = true): AgentOption => ({
  id,
  name: id === "claude" ? "Claude" : "Codex",
  available,
  auth: "ok",
  efforts: [],
});

describe("request direction activity", () => {
  test("separates queued changes from work an agent has picked up", () => {
    const requests = [
      request("queued", "queued", "Queued"),
      request("picked", "picked-up", "Picked"),
      request("running", "running", "Running"),
      request("failed", "failed", "Failed"),
    ];

    expect(changingRequestTitles(requests)).toEqual(["Queued", "Picked", "Running"]);
    expect([...workingRequestTitles(requests)]).toEqual(["Picked", "Running"]);
  });

  test("a fork leaves its parent's document alone", () => {
    // A variant is built beside the direction it was asked of, and the agent
    // is told to leave that direction exactly as it is. Counting the parent as
    // changing forgot its duplicate verdict and read it again after every
    // fork, which is the default kind of request.
    const requests = [
      { ...request("fork", "picked-up", "Parent"), mode: "variant" as const },
      { ...request("edit", "picked-up", "Edited"), mode: "replace" as const },
      request("plain", "queued", "Unmarked"),
    ];

    expect(changingRequestTitles(requests)).toEqual(["Edited", "Unmarked"]);
    expect([...workingRequestTitles(requests)]).toEqual(["Parent", "Edited"]);
  });
});

describe("composerAgent", () => {
  test("offers the chooser while agents are detected and none is chosen", () => {
    expect(composerAgent(null, [option("codex", false), option("claude")])).toEqual({
      kind: "choose",
    });
  });

  test.each([[[] as AgentOption[]], [[option("claude", false)]]])(
    "disappears when no agent is detected: %j",
    (available) => {
      expect(composerAgent(null, available)).toEqual({ kind: "none" });
    },
  );

  test("wears the chosen agent's name", () => {
    expect(composerAgent("claude", [option("codex"), option("claude")])).toEqual({
      kind: "chosen",
      id: "claude",
      name: "Claude",
    });
  });

  test("gives an existing custom choice a display name", () => {
    expect(composerAgent("custom", [option("claude")])).toEqual({
      kind: "chosen",
      id: "custom",
      name: "Custom",
    });
  });

  test("names a custom choice after its own command", () => {
    expect(composerAgent("custom", [], "aider --yes {prompt}")).toEqual({
      kind: "chosen",
      id: "custom",
      name: "aider",
    });
    expect(composerAgent("custom", [], "/usr/local/bin/goose run {prompt}")).toEqual({
      kind: "chosen",
      id: "custom",
      name: "goose",
    });
    expect(composerAgent("custom", [], "   ")).toEqual({
      kind: "chosen",
      id: "custom",
      name: "Custom",
    });
  });

  test("drops a chosen agent whose binary is no longer detected", () => {
    expect(composerAgent("claude", [option("claude", false)])).toEqual({ kind: "none" });
    expect(composerAgent("claude", [option("claude", false), option("codex")])).toEqual({
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
      id: "running",
      name: "Claude",
      activity: "editing src/Hero.tsx",
      startedAt: 1700000000000,
      title: "Warm serif",
      stopping: false,
      waiting: null,
    });
  });

  test("treats a running request as active before the agent poll catches up", () => {
    expect(requestCard([request("running", "running")], idleAgent, true)).toEqual({
      kind: "running",
      id: "running",
      name: "Your agent",
      activity: null,
      startedAt: null,
      title: "Aurora",
      stopping: false,
      waiting: null,
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

  test("offers the most recent failure with the reason it ended", () => {
    expect(
      requestCard(
        [
          request("older", "failed"),
          request("newer", "failed", "Dark grotesk", {
            code: "provider-overloaded",
            message: "Claude's provider was overloaded and gave up.",
          }),
        ],
        idleAgent,
        true,
      ),
    ).toEqual({
      kind: "failed",
      id: "newer",
      title: "Dark grotesk",
      reason: "Claude's provider was overloaded and gave up.",
    });
  });

  test("a stop is its own card, so nothing offers to redo what was stopped", () => {
    // The scenario this came from: a run cancelled, then the same words typed
    // again. Both requests ended, and the card has to tell them apart.
    expect(
      requestCard(
        [
          request("failed", "failed", "Poster", {
            code: "provider-overloaded",
            message: "Claude's provider was overloaded and gave up.",
          }),
          request("stopped", "cancelled", "Poster"),
        ],
        idleAgent,
        true,
      ),
    ).toEqual({ kind: "stopped", id: "stopped", title: "Poster" });
  });

  test("a stop in progress drops the backoff line and says so", () => {
    // Between the click and the agent actually going, the card must not keep
    // describing a live run, and must not still be blaming the provider.
    expect(
      requestCard(
        [request("running", "running", "Poster")],
        {
          ...idleAgent,
          running: true,
          name: "Claude",
          stopping: true,
          waiting: { attempt: 4, max: 10, status: 529, reason: "overloaded" },
        },
        true,
      ),
    ).toMatchObject({ kind: "running", stopping: true, waiting: null });
  });

  test("a failure with no recorded reason still names the direction", () => {
    expect(requestCard([request("old", "failed", "Poster")], idleAgent, true)).toEqual({
      kind: "failed",
      id: "old",
      title: "Poster",
      reason: null,
    });
  });

  test("a run inside the vendor's backoff says what it is waiting on", () => {
    const card = requestCard(
      [request("running", "running", "Poster")],
      {
        ...idleAgent,
        running: true,
        name: "Claude",
        waiting: { attempt: 4, max: 10, status: 529, reason: "overloaded" },
      },
      true,
    );
    expect(card).toMatchObject({
      kind: "running",
      waiting: { attempt: 4, max: 10 },
    });
  });

  test("stays empty while the queue is empty", () => {
    expect(requestCard([], { ...idleAgent, attached: true }, true)).toBeNull();
  });
});

describe("waitingLabel", () => {
  test("names the provider's own reason, with the attempt it is on", () => {
    expect(waitingLabel({ attempt: 3, max: 10, status: 529, reason: "overloaded" })).toBe(
      "provider is overloaded · retry 3 of 10",
    );
    expect(waitingLabel({ attempt: 2, max: 10, status: 401, reason: "authentication_failed" })).toBe(
      "provider refused the login · retry 2 of 10",
    );
    expect(waitingLabel({ attempt: 1, max: 10, status: 429, reason: null })).toBe(
      "provider is rate limiting · retry 1 of 10",
    );
    // A CLI that names no ceiling still gets a truthful line.
    expect(waitingLabel({ attempt: 2, max: null, status: null, reason: null })).toBe(
      "provider returned an error · retry 2",
    );
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

describe("notesAwaitingChange", () => {
  const request = (over: Partial<RequestStatus>): RequestStatus => ({
    id: "r1",
    status: "queued",
    title: "Poster",
    ...over,
  });

  test("collects the notes every unsettled change answers", () => {
    const found = notesAwaitingChange([
      request({ id: "r1", notes: ["a", "b"], status: "queued" }),
      request({ id: "r2", notes: ["c"], status: "running" }),
      request({ id: "r3", notes: ["d"], status: "picked-up" }),
    ]);

    expect([...found].toSorted()).toEqual(["a", "b", "c", "d"]);
  });

  // A change that failed or was stopped never answered its notes. They are
  // waiting to be sent again, which is exactly what an unmarked pin means.
  test("leaves out the notes of a change nobody is working on", () => {
    const found = notesAwaitingChange([
      request({ id: "r1", notes: ["a"], status: "failed" }),
      request({ id: "r2", notes: ["b"], status: "cancelled" }),
    ]);

    expect([...found]).toEqual([]);
  });

  test("a change typed with no pins contributes nothing", () => {
    expect([...notesAwaitingChange([request({})])]).toEqual([]);
  });

  test("one note answered by two changes is counted once", () => {
    const found = notesAwaitingChange([
      request({ id: "r1", notes: ["a"] }),
      request({ id: "r2", notes: ["a"] }),
    ]);

    expect([...found]).toEqual(["a"]);
  });
});
