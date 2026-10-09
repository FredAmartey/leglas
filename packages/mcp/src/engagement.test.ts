import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createEngagement } from "./engagement.js";

/** What the server was told, in order: `true` for watching, `false` for gone. */
let posts: boolean[] = [];

let answer: () => Promise<Response> = async () => new Response(null, { status: 204 });

const watch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
  posts.push(JSON.parse(String(init?.body)).watching);

  return answer();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LEGLAS_PORT", "");
  vi.stubGlobal("fetch", watch);
  posts = [];
  answer = async () => new Response(null, { status: 204 });
  watch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The beat, sent every two seconds while engaged. */
const beating = () => vi.getTimerCount() > 0;

describe("createEngagement", () => {
  test("touch starts the beat and says watching at once, to this machine's Leglas", async () => {
    const engagement = createEngagement();

    void engagement.touch();

    expect(posts).toEqual([true]);
    expect(String(watch.mock.calls[0]?.[0])).toBe("http://localhost:4100/leglas/api/watch");
    expect(watch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(beating()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts).toEqual([true, true]);
  });

  test("the first touch of a cycle settles only after the server heard it", async () => {
    let release!: () => void;

    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null, { status: 204 }));
      });

    const engagement = createEngagement();

    // The caller reads the queue right after this, so the runner's back-off
    // must be registered before it settles.
    let settled = false;

    const first = engagement.touch().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(posts).toEqual([true]);
    expect(settled).toBe(false);
    release();
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
    answer = () => Promise.reject(new Error("server gone"));

    await expect(createEngagement().touch()).resolves.toBeUndefined();
  });

  test("a second touch extends the engagement instead of stacking timers", async () => {
    const engagement = createEngagement();
    void engagement.touch();
    await vi.advanceTimersByTimeAsync(100_000);
    void engagement.touch();

    await vi.advanceTimersByTimeAsync(100_000);

    // 200s after the first touch but only 100s after the second: still on.
    expect(posts).not.toContain(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  test("a quiet spell lets the engagement lapse, and says so", async () => {
    void createEngagement().touch();

    await vi.advanceTimersByTimeAsync(122_000);

    expect(posts.filter((watching) => !watching)).toHaveLength(1);
    expect(posts.at(-1)).toBe(false);
    expect(beating()).toBe(false);
  });

  test("stop ends an active beat and reports detachment once", async () => {
    const engagement = createEngagement();
    void engagement.touch();

    await engagement.stop();
    await engagement.stop();

    expect(posts).toEqual([true, false]);
    expect(beating()).toBe(false);
  });

  test("stop before any touch stays silent", async () => {
    await createEngagement().stop();

    expect(posts).toEqual([]);
  });
});
