import { describe, expect, test } from "vitest";

import {
  buildLabel,
  cardFor,
  isSlotOf,
  runStartedAt,
  slotsByTitle,
  surfaceOf,
  type GenerationJob,
  type GenerationSlot,
} from "./generation.js";

function slot(title: string, state: GenerationSlot["state"]): GenerationSlot {
  return {
    key: `hero-${title.toLowerCase()}`,
    title,
    idea: `${title}, the idea.`,
    file: `src/heroes/hero-${title.toLowerCase()}.tsx`,
    state,
    startedAt: 0,
    endedAt: null,
    failure: state === "failed" ? { code: "agent-error", message: "It went wrong." } : null,
    fixed: false,
  };
}

function job(state: GenerationJob["state"], slots: GenerationSlot[], extra = {}): GenerationJob {
  return {
    id: "gen-1",
    surface: "hero",
    brief: "Dinner in thirty minutes",
    count: 3,
    state,
    startedAt: 1_000,
    plannedAt: null,
    endedAt: null,
    error: null,
    slots,
    ...extra,
  };
}

describe("the surface a direction belongs to", () => {
  test("is the v- parameter its address carries", () => {
    expect(surfaceOf("/?v-hero=table")).toBe("hero");
    expect(surfaceOf("/pricing?ref=nav&v-pricing-page=a")).toBe("pricing-page");
  });

  test("is none for an address that is not on a switch", () => {
    expect(surfaceOf("/")).toBeNull();
    expect(surfaceOf("/?utm_source=x")).toBeNull();
    expect(surfaceOf("/?v-=x")).toBeNull();
  });
});

test("a newer set's slot speaks for a title both sets have", () => {
  const first = job("done", [slot("Ledger", "failed")], { id: "gen-1" });
  const second = job("building", [slot("Ledger", "building")], { id: "gen-2" });

  expect(slotsByTitle([first, second]).get("Ledger")?.job.id).toBe("gen-2");
});

describe("the card above the composer", () => {
  test("says what is being planned, then how the build is going", () => {
    expect(cardFor(job("planning", []))).toEqual({
      tone: "working",
      text: "Planning 3 hero directions…",
    });
    expect(
      cardFor(
        job("building", [
          slot("Ledger", "ready"),
          slot("Steam", "building"),
          slot("Timer", "checking"),
        ]),
      ),
    ).toEqual({ tone: "working", text: "Building 3 hero directions, 1 ready" });
    expect(cardFor(job("building", [slot("Ledger", "building")]))).toEqual({
      tone: "working",
      text: "Building 1 hero direction",
    });
  });

  test("gives the time a finished set took", () => {
    const done = job(
      "done",
      [slot("Ledger", "ready"), slot("Steam", "ready"), slot("Timer", "ready")],
      {
        endedAt: 83_400,
      },
    );

    expect(cardFor(done)).toEqual({ tone: "done", text: "3 hero directions ready in 82 s" });
  });

  test("names the directions that failed or were stopped", () => {
    expect(
      cardFor(
        job("done", [slot("Ledger", "ready"), slot("Steam", "ready"), slot("Pantry", "failed")]),
      ),
    ).toEqual({ tone: "failed", text: "2 of 3 ready. Pantry failed" });
    expect(
      cardFor(
        job("done", [
          slot("Ledger", "ready"),
          slot("Steam", "ready"),
          slot("Pantry", "failed"),
          slot("Chalk", "stopped"),
          slot("Market", "failed"),
        ]),
      ),
    ).toEqual({ tone: "failed", text: "2 of 5 ready. Pantry and Market failed. Chalk stopped" });
  });

  test("passes on the server's sentence when planning failed", () => {
    const failed = job("failed", [], { error: "Planning took too long, so Leglas stopped it." });

    expect(cardFor(failed)).toEqual({
      tone: "failed",
      text: "Planning took too long, so Leglas stopped it.",
    });
  });

  test("says a set was stopped, whether it had directions yet or not", () => {
    expect(cardFor(job("stopped", []))).toEqual({
      tone: "stopped",
      text: "Stopped the hero directions",
    });
    expect(cardFor(job("stopped", [slot("Ledger", "stopped"), slot("Steam", "stopped")]))).toEqual({
      tone: "stopped",
      text: "Stopped the hero directions",
    });
  });
});

describe("a set built again in part", () => {
  // Ledger built with the set; Pantry failed and was tried again ten minutes later.
  const retried = () =>
    job(
      "done",
      [
        { ...slot("Ledger", "ready"), startedAt: 5_010 },
        { ...slot("Pantry", "ready"), startedAt: 640_000 },
      ],
      { plannedAt: 5_000, endedAt: 700_000 },
    );

  test("runs from its latest retry, not from when the set began", () => {
    expect(runStartedAt(retried())).toBe(640_000);
    expect(runStartedAt(job("planning", [], { plannedAt: null }))).toBe(1_000);
  });

  test("does not claim the whole set took the time since it began", () => {
    expect(cardFor(retried())).toEqual({ tone: "done", text: "2 hero directions ready" });
  });
});

test("a set with nothing built says so instead of counting zero", () => {
  expect(
    cardFor(
      job("done", [slot("Ledger", "failed"), slot("Steam", "failed"), slot("Timer", "stopped")]),
    ),
  ).toEqual({
    tone: "failed",
    text: "None of the 3 were built. Ledger and Steam failed. Timer stopped",
  });
  expect(cardFor(job("done", [slot("Pantry", "failed")]))).toEqual({
    tone: "failed",
    text: "Pantry failed",
  });
});

test("a row is a slot's only when its address carries the slot's key", () => {
  const view = { job: job("done", []), slot: slot("Ledger", "failed") };

  expect(isSlotOf("/?v-hero=hero-ledger", view)).toBe(true);
  expect(isSlotOf("/?v-hero=ledger-by-hand", view)).toBe(false);
  expect(isSlotOf("/?v-pricing=hero-ledger", view)).toBe(false);
});

test("the build button says how many and whose plan pays", () => {
  expect(buildLabel(3)).toBe("Build 3 with Claude");
});
