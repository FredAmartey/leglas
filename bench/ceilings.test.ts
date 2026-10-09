import { describe, expect, test } from "vitest";

import { compare, lower, unexplainedRaises, type CeilingFile } from "./ceilings.ts";

/**
 * The rules that make the journeys a ratchet rather than a report: a ceiling
 * only comes down on its own, and going up leaves a reason behind. CI runs one
 * walk and compares; nothing else there would notice these rules loosening.
 */
describe("the ratchet", () => {
  test("a count above its ceiling regresses and one below it is stale", () => {
    const verdicts = compare({ requests: 16, sockets: 1, frames: 0 }, { requests: 17, sockets: 0 });

    expect(verdicts.map(({ count, status }) => [count, status])).toEqual([
      ["frames", "ok"],
      ["requests", "regression"],
      ["sockets", "stale"],
    ]);
  });

  test("a count missing from either side is zero", () => {
    expect(compare({}, { "processes.git": 1 })[0]?.status).toBe("regression");
    expect(compare({ "alive.codex": 1 }, {})[0]?.status).toBe("stale");
  });

  test("update lowers a stale ceiling and never raises one", () => {
    expect(lower({ requests: 17, sockets: 2 }, { requests: 20, sockets: 1 })).toEqual({
      requests: 17,
      sockets: 1,
    });
  });

  test("update leaves a ceiling alone when its count differed between runs", () => {
    // `frames` came out 0 on some walks and 1 on others, so it has no value.
    expect(lower({ requests: 17, frames: 1 }, { requests: 16 }, ["frames"])).toEqual({
      requests: 16,
      frames: 1,
    });
  });
});

describe("checking ceilings against a base", () => {
  const base: CeilingFile = {
    ceilings: { boot: { "processes.lsof": 2 } },
    raised: [{ count: "boot.processes.lsof", from: 1, to: 2, why: "earlier", on: "2026-10-01" }],
  };

  const raisedTo = (to: number, raised: CeilingFile["raised"]): CeilingFile => ({
    ceilings: { boot: { "processes.lsof": to } },
    raised,
  });

  test("a ceiling that rose needs a new entry naming it and its new value", () => {
    expect(unexplainedRaises(base, raisedTo(3, base.raised))).toEqual([
      "boot.processes.lsof rose from 2 to 3",
    ]);

    const logged = {
      count: "boot.processes.lsof",
      from: 2,
      to: 3,
      why: "a third",
      on: "2026-10-09",
    };

    expect(unexplainedRaises(base, raisedTo(3, [...base.raised, logged]))).toEqual([]);

    // An entry with no reason in it explains nothing, however it got into the file.
    expect(unexplainedRaises(base, raisedTo(3, [...base.raised, { ...logged, why: " " }]))).toEqual(
      ["boot.processes.lsof rose from 2 to 3"],
    );
  });

  test("an entry already at the base can't explain a new rise to the same value", () => {
    const again: CeilingFile = {
      ceilings: { boot: { "processes.lsof": 1 } },
      raised: base.raised,
    };

    expect(unexplainedRaises(again, raisedTo(2, base.raised))).toEqual([
      "boot.processes.lsof rose from 1 to 2",
    ]);
  });

  test("a count new to a journey rose from zero, and a new journey has nothing to rise from", () => {
    const head: CeilingFile = {
      ceilings: { boot: { "processes.lsof": 2, "processes.git": 1 }, switch: { requests: 9 } },
      raised: base.raised,
    };

    expect(unexplainedRaises(base, head)).toEqual(["boot.processes.git rose from 0 to 1"]);
  });
});
