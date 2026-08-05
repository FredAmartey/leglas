import { describe, expect, test } from "vitest";

import { requestStatusLine, type RequestStatus } from "./request-status.js";

const request = (title: string, status: RequestStatus["status"]): RequestStatus => ({ title, status });

describe("requestStatusLine", () => {
  test("returns nothing for an empty queue", () => expect(requestStatusLine([], "Aurora")).toBeNull());
  test("ignores requests for other directions", () =>
    expect(requestStatusLine([request("Current", "queued")], "Aurora")).toBeNull(),
  );
  test("counts queued requests", () => {
    expect(requestStatusLine([request("Aurora", "queued")], "Aurora")).toBe("1 change queued for your agent");
    expect(requestStatusLine([request("Aurora", "queued"), request("Aurora", "queued")], "Aurora")).toBe("2 changes queued for your agent");
  });
  test("reports picked-up requests", () =>
    expect(requestStatusLine([request("Aurora", "picked-up")], "Aurora")).toBe("Your agent is on it"),
  );
  test("prioritizes queued requests in a mixed queue", () =>
    expect(requestStatusLine([request("Aurora", "picked-up"), request("Aurora", "queued")], "Aurora")).toBe("1 change queued for your agent"),
  );
});

describe("requestStatusLine with an agent attached", () => {
  test("says the agent is listening when there is nothing pending", () =>
    expect(requestStatusLine([], "Aurora", true)).toBe("Your agent is listening"),
  );
  test("still says nothing when no direction is active", () =>
    expect(requestStatusLine([], null, true)).toBeNull(),
  );
  test("counts queued requests rather than announcing the agent", () =>
    expect(requestStatusLine([request("Aurora", "queued")], "Aurora", true)).toBe("1 change queued for your agent"),
  );
  test("reports work in progress rather than announcing the agent", () =>
    expect(requestStatusLine([request("Aurora", "picked-up")], "Aurora", true)).toBe("Your agent is on it"),
  );
  test("ignores an attached agent's work on another direction", () =>
    expect(requestStatusLine([request("Ledger", "picked-up")], "Aurora", true)).toBe("Your agent is listening"),
  );
  test("behaves exactly as before when nothing is attached", () =>
    expect(requestStatusLine([], "Aurora", false)).toBeNull(),
  );
});
