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
