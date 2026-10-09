import { describe, expect, test } from "vitest";

import {
  cardDetail,
  cardHeadline,
  changingRequestTitles,
  composerAgent,
  formatElapsed,
  notesAwaitingChange,
  requestCard,
  waitingLabel,
  workingRequestTitles,
  type AgentOption,
  type AgentStatus,
  type RequestCard,
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
    // A variant is built beside its parent, which the agent is told to leave
    // alone. Counting the parent as changing dropped its duplicate verdict and
    // re-read it after every fork, the default request.
    const requests = [
      { ...request("fork", "picked-up", "Parent"), mode: "variant" as const },
      { ...request("edit", "picked-up", "Edited"), mode: "replace" as const },
      request("plain", "queued", "Unmarked"),
    ];

    expect(changingRequestTitles(requests)).toEqual(["Edited", "Unmarked"]);
    expect([...workingRequestTitles(requests)]).toEqual(["Parent", "Edited"]);
  });
});

test("composerAgent offers the chooser, wears the chosen agent's name, or disappears", () => {
  const chosen = (id: string, name: string) => ({ kind: "chosen", id, name });

  // Agents detected and none chosen; then none detected, or none available.
  expect(composerAgent(null, [option("codex", false), option("claude")])).toEqual({
    kind: "choose",
  });
  expect(composerAgent(null, [])).toEqual({ kind: "none" });
  expect(composerAgent(null, [option("claude", false)])).toEqual({ kind: "none" });

  expect(composerAgent("claude", [option("codex"), option("claude")])).toEqual(
    chosen("claude", "Claude"),
  );
  // A custom choice is named after its own command, or else just Custom.
  expect(composerAgent("custom", [option("claude")])).toEqual(chosen("custom", "Custom"));
  expect(composerAgent("custom", [], "aider --yes {prompt}")).toEqual(chosen("custom", "aider"));
  expect(composerAgent("custom", [], "/usr/local/bin/goose run {prompt}")).toEqual(
    chosen("custom", "goose"),
  );
  expect(composerAgent("custom", [], "   ")).toEqual(chosen("custom", "Custom"));

  // A chosen binary no longer detected loses its name.
  expect(composerAgent("claude", [option("claude", false)])).toEqual({ kind: "none" });
  expect(composerAgent("claude", [option("claude", false), option("codex")])).toEqual({
    kind: "choose",
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
      quietSince: null,
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
      quietSince: null,
    });
  });

  test("with nothing running: the queue, then a pickup, then the latest ending", () => {
    const attached = { ...idleAgent, attached: true };
    const failed = request("failed", "failed");
    const pickedUp = request("picked-up", "picked-up");
    const queued = [request("queued-1", "queued"), request("queued-2", "queued")];

    expect(requestCard([failed, pickedUp, ...queued], attached, true)).toEqual({
      kind: "queued",
      count: 2,
      attended: true,
    });
    // Nothing will drain it.
    expect(requestCard([request("queued", "queued")], idleAgent, false)).toEqual({
      kind: "queued",
      count: 1,
      attended: false,
    });
    expect(requestCard([failed, pickedUp], attached, true)).toEqual({ kind: "picked-up" });

    const overloaded = {
      code: "provider-overloaded",
      message: "Claude's provider was overloaded and gave up.",
    };

    expect(
      requestCard(
        [request("older", "failed"), request("newer", "failed", "Dark grotesk", overloaded)],
        idleAgent,
        true,
      ),
    ).toEqual({ kind: "failed", id: "newer", title: "Dark grotesk", reason: overloaded.message });
    expect(requestCard([request("old", "failed", "Poster")], idleAgent, true)).toEqual({
      kind: "failed",
      id: "old",
      title: "Poster",
      reason: null,
    });
    // A run cancelled and the same words typed again: a stop is its own card,
    // so nothing offers to redo what was stopped.
    expect(
      requestCard(
        [
          request("failed", "failed", "Poster", overloaded),
          request("stopped", "cancelled", "Poster"),
        ],
        idleAgent,
        true,
      ),
    ).toEqual({ kind: "stopped", id: "stopped", title: "Poster" });
    expect(requestCard([], attached, true)).toBeNull();
  });

  test("a run carries the vendor's backoff and its quiet, and a stop in progress drops both", () => {
    const running = [request("running", "running", "Poster")];

    const agent = {
      ...idleAgent,
      running: true,
      name: "Claude",
      waiting: { attempt: 4, max: 10, status: 529, reason: "overloaded" },
      quietSince: 2_000,
    };

    expect(requestCard(running, agent, true)).toMatchObject({
      kind: "running",
      waiting: { attempt: 4, max: 10 },
      quietSince: 2_000,
    });
    // Between the click and the agent going, the card must not describe a live
    // run or blame the provider.
    expect(requestCard(running, { ...agent, stopping: true }, true)).toMatchObject({
      kind: "running",
      stopping: true,
      waiting: null,
      quietSince: null,
    });
  });
});

describe("waitingLabel", () => {
  test("names the provider's own reason, with the attempt it is on", () => {
    expect(waitingLabel({ attempt: 3, max: 10, status: 529, reason: "overloaded" })).toBe(
      "provider is overloaded · retry 3 of 10",
    );
    expect(
      waitingLabel({ attempt: 2, max: 10, status: 401, reason: "authentication_failed" }),
    ).toBe("provider refused the login · retry 2 of 10");
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

// A failed or stopped change never answered its notes, so they're waiting to be
// sent again, which is what an unmarked pin means.
test("notesAwaitingChange collects the notes every unsettled change answers, and no others", () => {
  const request = (over: Partial<RequestStatus>): RequestStatus => ({
    id: "r1",
    status: "queued",
    title: "Poster",
    ...over,
  });

  const found = notesAwaitingChange([
    request({ id: "r1", notes: ["a", "b"], status: "queued" }),
    request({ id: "r2", notes: ["c"], status: "running" }),
    request({ id: "r3", notes: ["d"], status: "picked-up" }),
    request({ id: "r4", notes: ["e"], status: "failed" }),
    request({ id: "r5", notes: ["f"], status: "cancelled" }),
    // Typed with no pins.
    request({ id: "r6" }),
  ]);

  expect([...found].toSorted()).toEqual(["a", "b", "c", "d"]);
});

describe("what the status card says", () => {
  const running: Extract<RequestCard, { kind: "running" }> = {
    kind: "running",
    id: "r1",
    name: "Claude",
    activity: "Editing hero.tsx",
    startedAt: 1_000,
    title: "Aurora",
    stopping: false,
    waiting: null,
    quietSince: null,
  };

  /** The card's two lines. */
  const said = (card: RequestCard) => [cardHeadline(card), cardDetail(card)];

  test("a headline for what happened, then the one useful thing about it", () => {
    expect(said(running)).toEqual(["Claude is on it", "Editing hero.tsx"]);
    // No activity yet: the direction it is changing is the next best thing.
    expect(said({ ...running, activity: null })).toEqual(["Claude is on it", "Aurora"]);
    // A provider backing off outranks the activity, so the wait is explained.
    expect(
      said({ ...running, waiting: { attempt: 2, max: 5, status: 429, reason: null } }),
    ).toEqual(["Claude is on it", "provider is rate limiting · retry 2 of 5"]);
    // A stop in progress says so until the agent actually goes.
    expect(said({ ...running, stopping: true })).toEqual([
      "Stopping Claude",
      "waiting for it to exit",
    ]);

    // The queue counts itself and says who takes it next.
    expect(said({ kind: "queued", count: 1, attended: true })).toEqual([
      "Change queued",
      "your agent picks it up next",
    ]);
    expect(cardHeadline({ kind: "queued", count: 3, attended: true })).toBe("3 changes queued");
    expect(cardDetail({ kind: "queued", count: 1, attended: false })).toBe(
      "pick who runs your changes",
    );

    // A failure shows the server's verdict, and the direction when there is none.
    const failed = { kind: "failed", id: "r1", title: "Aurora", reason: "Claude is not signed in" };
    expect(said({ ...failed, kind: "failed" })).toEqual([
      "That change failed",
      "Claude is not signed in",
    ]);
    expect(cardDetail({ ...failed, kind: "failed", reason: null })).toBe("Aurora");

    // A stop is the person's own; a pickup needs no detail.
    expect(said({ kind: "stopped", id: "r1", title: "Aurora" })).toEqual([
      "You stopped that change",
      "Aurora",
    ]);
    expect(said({ kind: "picked-up" })).toEqual(["Your agent is on it", null]);
  });

  test("a run that has gone quiet says for how long, in place of its last activity", () => {
    const quiet = { ...running, quietSince: 1_000_000 };

    expect(cardDetail(quiet, 1_000_000 + 4 * 60_000 + 12_000)).toBe("no output for 4m 12s");
    // A provider backing off explains the same silence better.
    expect(
      cardDetail({ ...quiet, waiting: { attempt: 2, max: 5, status: 529, reason: null } }, 0),
    ).toBe("provider is overloaded · retry 2 of 5");
    expect(cardDetail({ ...quiet, stopping: true }, 0)).toBe("waiting for it to exit");
    // Without a clock, the card falls back to what it had.
    expect(cardDetail(quiet)).toBe("Editing hero.tsx");
  });
});
