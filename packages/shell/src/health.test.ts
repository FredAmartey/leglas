import { describe, expect, test } from "vitest";

import { nextHealthState, type HealthState } from "./health.js";

const up: HealthState = { reachable: true, wasDown: false };
const down: HealthState = { reachable: false, wasDown: true };

describe("nextHealthState", () => {
  test("stays up while the dev server keeps answering", () => {
    expect(nextHealthState(up, true)).toEqual({ reachable: true, wasDown: false });
  });

  test("goes down the moment it stops answering", () => {
    expect(nextHealthState(up, false)).toEqual({ reachable: false, wasDown: true });
  });

  test("remembers it was down after it comes back, so panes can be recovered", () => {
    expect(nextHealthState(down, true)).toEqual({ reachable: true, wasDown: true });
  });

  test("clears the memory once the recovery has been handled", () => {
    const recovered = nextHealthState(down, true);

    expect(nextHealthState({ ...recovered, wasDown: false }, true)).toEqual({
      reachable: true,
      wasDown: false,
    });
  });

  test("does not re-arm recovery while it stays down", () => {
    expect(nextHealthState(down, false)).toEqual({ reachable: false, wasDown: true });
  });

  test("treats the first successful check as ordinary, not a recovery", () => {
    // Starting optimistic means a normal boot never flashes a reload.
    expect(nextHealthState({ reachable: true, wasDown: false }, true).wasDown).toBe(false);
  });
});
