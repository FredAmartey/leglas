import { describe, expect, test } from "vitest";

import {
  cardFor,
  isSlotOf,
  runStartedAt,
  slotsByTitle,
  surfaceOf,
  surfacesOf,
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
    activity: null,
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
    basedOn: null,
    agent: "claude",
    ...extra,
  };
}

test("a direction's surface is the v- parameter its address carries, listed once in order", () => {
  expect(surfaceOf("/?v-hero=table")).toBe("hero");
  expect(surfaceOf("/pricing?ref=nav&v-pricing-page=a")).toBe("pricing-page");
  // An address that is not on a switch has none.
  expect(surfaceOf("/")).toBeNull();
  expect(surfaceOf("/?utm_source=x")).toBeNull();
  expect(surfaceOf("/?v-=x")).toBeNull();

  expect(
    surfacesOf(["/?v-hero=table", "/", "/pricing?v-pricing=a", "/?v-hero=menu", "/?ref=x"]),
  ).toEqual(["hero", "pricing"]);
});

test("a newer set's slot speaks for a title both sets have, and a row is a slot's only by its key", () => {
  const first = job("done", [slot("Ledger", "failed")], { id: "gen-1" });
  const second = job("building", [slot("Ledger", "building")], { id: "gen-2" });

  expect(slotsByTitle([first, second]).get("Ledger")?.job.id).toBe("gen-2");

  // The row's address must carry the slot's key on the set's surface.
  const view = { job: first, slot: slot("Ledger", "failed") };

  expect(isSlotOf("/?v-hero=hero-ledger", view)).toBe(true);
  expect(isSlotOf("/?v-hero=ledger-by-hand", view)).toBe(false);
  expect(isSlotOf("/?v-pricing=hero-ledger", view)).toBe(false);
});

test("the card above the composer says what is planned, how the build goes and how it ended", () => {
  const card = (state: GenerationJob["state"], slots: GenerationSlot[], extra = {}) =>
    cardFor(job(state, slots, extra));

  expect(card("planning", [])).toEqual({ tone: "working", text: "Planning 3 hero directions…" });
  expect(
    card("building", [
      slot("Ledger", "ready"),
      slot("Steam", "building"),
      slot("Timer", "checking"),
    ]),
  ).toEqual({ tone: "working", text: "Building 3 hero directions, 1 ready" });
  expect(card("building", [slot("Ledger", "building")])).toEqual({
    tone: "working",
    text: "Building 1 hero direction",
  });

  // The time a finished set took.
  expect(
    card("done", [slot("Ledger", "ready"), slot("Steam", "ready"), slot("Timer", "ready")], {
      endedAt: 83_400,
    }),
  ).toEqual({ tone: "done", text: "3 hero directions ready in 82 s" });

  // The directions that failed or were stopped, by name, and no count of zero.
  expect(
    card("done", [slot("Ledger", "ready"), slot("Steam", "ready"), slot("Pantry", "failed")]),
  ).toEqual({ tone: "failed", text: "2 of 3 ready. Pantry failed" });
  expect(
    card("done", [
      slot("Ledger", "ready"),
      slot("Steam", "ready"),
      slot("Pantry", "failed"),
      slot("Chalk", "stopped"),
      slot("Market", "failed"),
    ]),
  ).toEqual({ tone: "failed", text: "2 of 5 ready. Pantry and Market failed. Chalk stopped" });
  expect(
    card("done", [slot("Ledger", "failed"), slot("Steam", "failed"), slot("Timer", "stopped")]),
  ).toEqual({
    tone: "failed",
    text: "None of the 3 were built. Ledger and Steam failed. Timer stopped",
  });
  expect(card("done", [slot("Pantry", "failed")])).toEqual({
    tone: "failed",
    text: "Pantry failed",
  });

  // The server's sentence when planning failed.
  expect(card("failed", [], { error: "Planning took too long, so Leglas stopped it." })).toEqual({
    tone: "failed",
    text: "Planning took too long, so Leglas stopped it.",
  });
  // Stopped, whether it had directions yet or not.
  const stopped = { tone: "stopped", text: "Stopped the hero directions" };
  expect(card("stopped", [])).toEqual(stopped);
  expect(card("stopped", [slot("Ledger", "stopped"), slot("Steam", "stopped")])).toEqual(stopped);

  // A set of variations is called what it is, from planning to its end.
  const like = { basedOn: "Table" };
  expect(card("planning", [], like).text).toBe("Planning 3 variations of Table…");
  expect(card("building", [slot("Ledger", "building")], like).text).toBe(
    "Building 1 variation of Table",
  );
  expect(
    card("done", [slot("Ledger", "ready"), slot("Steam", "ready")], { ...like, endedAt: 9_000 })
      .text,
  ).toBe("2 variations of Table ready in 8 s");
  expect(card("stopped", [], like).text).toBe("Stopped the variations of Table");
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
    // Stopped before its plan landed, then tried again: no plan time, so the start is a retry.
    expect(
      runStartedAt(
        job("building", [{ ...slot("Ledger", "building"), startedAt: 900_000 }], {
          plannedAt: null,
        }),
      ),
    ).toBe(900_000);
  });

  test("does not claim the whole set took the time since it began", () => {
    expect(cardFor(retried())).toEqual({ tone: "done", text: "2 hero directions ready" });
  });
});
