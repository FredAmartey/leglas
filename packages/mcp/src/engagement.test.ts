import { describe, expect, test } from "vitest";

import { createEngagement } from "./engagement.js";

function harness(start = 1_000_000) {
  const posts: boolean[] = [];
  let now = start;
  let tick: (() => void) | null = null;
  let cleared = 0;
  const engagement = createEngagement({
    post: async (watching) => {
      posts.push(watching);
    },
    setInterval: (callback) => {
      tick = callback;
      return "timer";
    },
    clearInterval: () => {
      cleared += 1;
      tick = null;
    },
    now: () => now,
  });
  return {
    engagement,
    posts,
    beat: () => tick?.(),
    beating: () => tick !== null,
    clearedCount: () => cleared,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("createEngagement", () => {
  test("touch starts the beat and says watching at once", () => {
    const h = harness();

    h.engagement.touch();

    expect(h.posts).toEqual([true]);
    expect(h.beating()).toBe(true);
    h.beat();
    expect(h.posts).toEqual([true, true]);
  });

  test("the first touch of a cycle settles only after the server heard it", async () => {
    let release: (() => void) | null = null;
    const posts: boolean[] = [];
    const engagement = createEngagement({
      post: (watching) =>
        new Promise<void>((resolve) => {
          posts.push(watching);
          release = resolve;
        }),
      setInterval: () => "timer",
      clearInterval: () => {},
    });

    // The caller reads the queue after this await: the runner's back-off
    // must already be registered, so the promise cannot settle early.
    let settled = false;
    const first = engagement.touch().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(posts).toEqual([true]);
    expect(settled).toBe(false);
    release?.();
    await first;
    expect(settled).toBe(true);

    // Mid-cycle the server already knows: no waiting on a second beat.
    let second = false;
    void engagement.touch().then(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(true);
    expect(posts).toEqual([true]);
  });

  test("a rejecting post never fails the touch that carried it", async () => {
    const engagement = createEngagement({
      post: () => Promise.reject(new Error("server gone")),
      setInterval: () => "timer",
      clearInterval: () => {},
    });

    await expect(engagement.touch()).resolves.toBeUndefined();
  });

  test("a second touch extends the engagement instead of stacking timers", () => {
    const h = harness();
    h.engagement.touch();
    h.advance(100_000);
    h.engagement.touch();

    h.advance(100_000);
    h.beat();

    // 200s after the first touch but only 100s after the second: still on.
    expect(h.posts).toEqual([true, true]);
    expect(h.beating()).toBe(true);
  });

  test("a quiet spell lets the engagement lapse, and says so", () => {
    const h = harness();
    h.engagement.touch();

    h.advance(121_000);
    h.beat();

    expect(h.posts).toEqual([true, false]);
    expect(h.beating()).toBe(false);
    expect(h.clearedCount()).toBe(1);
  });

  test("stop ends an active beat and reports detachment once", async () => {
    const h = harness();
    h.engagement.touch();

    await h.engagement.stop();
    await h.engagement.stop();

    expect(h.posts).toEqual([true, false]);
    expect(h.beating()).toBe(false);
  });

  test("stop before any touch stays silent", async () => {
    const h = harness();

    await h.engagement.stop();

    expect(h.posts).toEqual([]);
  });
});
