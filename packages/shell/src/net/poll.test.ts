import { describe, expect, test } from "vitest";

import { startPoll, wasAborted, type PollTimers } from "./poll.js";
import type { TimerHandle } from "./timers.js";

/**
 * A clock the test drives, so ten minutes of polling take a millisecond and
 * nothing depends on real time.
 */
function clock() {
  type Interval = { callback: () => void; every: number; next: number };

  type Timeout = { callback: () => void; at: number };

  let now = 0;
  let handle = 0;
  const intervals = new Map<TimerHandle, Interval>();
  const timeouts = new Map<TimerHandle, Timeout>();

  const timers: PollTimers = {
    setInterval: (callback, every) => {
      const id = ++handle;
      intervals.set(id, { callback, every, next: now + every });

      return id;
    },
    clearInterval: (id) => void intervals.delete(id),
    setTimeout: (callback, after) => {
      const id = ++handle;
      timeouts.set(id, { callback, at: now + after });

      return id;
    },
    clearTimeout: (id) => void timeouts.delete(id),
  };

  // The fake timers don't touch real ones, so a zero-delay timeout lets queued
  // promise callbacks run before asserting.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const advance = async (by: number) => {
    const target = now + by;
    // A real timer never fires ahead of an already queued promise callback;
    // draining first keeps the fake honest.
    await flush();

    for (;;) {
      let soonest = Infinity;

      for (const timeout of timeouts.values()) soonest = Math.min(soonest, timeout.at);

      for (const interval of intervals.values()) soonest = Math.min(soonest, interval.next);

      if (soonest > target) break;

      now = soonest;

      for (const [id, timeout] of [...timeouts]) {
        if (timeout.at <= now) {
          timeouts.delete(id);
          timeout.callback();
        }
      }

      for (const interval of [...intervals.values()]) {
        if (interval.next <= now) {
          interval.next = now + interval.every;
          interval.callback();
        }
      }

      await flush();
    }

    now = target;
    await flush();
  };

  return { advance, flush, timers, armed: () => timeouts.size };
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function deferred() {
  let settle!: () => void;
  let fail!: (error: Error) => void;

  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });

  return { promise, settle, fail };
}

/** Record every read the loop starts, and the signal it was handed. */
function reads(task: (signal: AbortSignal) => Promise<void>) {
  const signals: AbortSignal[] = [];

  return {
    signals,
    task: (signal: AbortSignal) => {
      signals.push(signal);

      return task(signal);
    },
  };
}

describe("startPoll", () => {
  test("reads once straight away instead of waiting out the first interval", async () => {
    const fake = clock();
    const recorded = reads(() => Promise.resolve());

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.flush();

    expect(recorded.signals).toHaveLength(1);
    stop();
  });

  test("never starts a second read while the first is still in flight", async () => {
    // The bug this loop prevents: a bare setInterval enqueues a read every tick
    // whether or not the last returned, so once the per-origin socket budget is
    // spent reads pile up faster than they drain and user clicks queue behind
    // them.
    const fake = clock();
    const recorded = reads(never);

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 600_000,
      timers: fake.timers,
    });

    await fake.advance(60_000);

    expect(recorded.signals).toHaveLength(1);
    stop();
  });

  test("starts the next read once the last one settles", async () => {
    const fake = clock();
    const first = deferred();
    let call = 0;
    const recorded = reads(() => (call++ === 0 ? first.promise : Promise.resolve()));

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 600_000,
      timers: fake.timers,
    });

    await fake.advance(10_000);
    expect(recorded.signals).toHaveLength(1);

    first.settle();
    await fake.advance(2000);

    expect(recorded.signals).toHaveLength(2);
    stop();
  });

  test("a failed read frees the slot instead of wedging the loop", async () => {
    const fake = clock();
    const first = deferred();
    let call = 0;
    const recorded = reads(() => (call++ === 0 ? first.promise : Promise.resolve()));

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 600_000,
      timers: fake.timers,
    });

    first.fail(new Error("the server went away"));
    await fake.advance(2000);

    expect(recorded.signals).toHaveLength(2);
    stop();
  });

  test("aborts a read that outlives its deadline, so the socket comes back", async () => {
    const fake = clock();
    const recorded = reads(never);

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.advance(9000);
    expect(recorded.signals[0]?.aborted).toBe(false);

    await fake.advance(2000);

    expect(recorded.signals[0]?.aborted).toBe(true);
    stop();
  });

  test("resumes reading after abandoning one that hung", async () => {
    // Abandoning must free the slot as well as the socket, or a task ignoring
    // its signal holds the loop shut.
    const fake = clock();
    const recorded = reads(never);

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.advance(12_000);

    expect(recorded.signals).toHaveLength(2);
    expect(recorded.signals[0]?.aborted).toBe(true);
    expect(recorded.signals[1]?.aborted).toBe(false);
    stop();
  });

  test("a read that comes back in time is left alone", async () => {
    const fake = clock();
    const recorded = reads(() => Promise.resolve());

    const stop = startPoll(recorded.task, {
      everyMs: 60_000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.advance(30_000);

    expect(recorded.signals[0]?.aborted).toBe(false);
    // Its deadline must be disarmed too, or every settled read leaves a timer
    // behind.
    expect(fake.armed()).toBe(0);
    stop();
  });

  test("stopping aborts the read still in flight", async () => {
    const fake = clock();
    const recorded = reads(never);

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 600_000,
      timers: fake.timers,
    });

    await fake.flush();
    stop();

    expect(recorded.signals[0]?.aborted).toBe(true);
    expect(fake.armed()).toBe(0);
  });

  test("stopping ends the loop for good", async () => {
    const fake = clock();
    const recorded = reads(() => Promise.resolve());

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.flush();
    stop();
    await fake.advance(60_000);

    expect(recorded.signals).toHaveLength(1);
  });

  test("stopping twice is harmless", async () => {
    const fake = clock();
    const recorded = reads(() => Promise.resolve());

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 10_000,
      timers: fake.timers,
    });

    await fake.flush();
    stop();

    expect(() => stop()).not.toThrow();
  });

  test("a read settling after the loop stopped changes nothing", async () => {
    const fake = clock();
    const late = deferred();
    const recorded = reads(() => late.promise);

    const stop = startPoll(recorded.task, {
      everyMs: 2000,
      timeoutMs: 600_000,
      timers: fake.timers,
    });

    await fake.flush();
    stop();
    late.settle();
    await fake.advance(60_000);

    expect(recorded.signals).toHaveLength(1);
  });
});

describe("wasAborted", () => {
  test("knows an abandoned read from anything the server said", () => {
    // A real abort out of fetch, in the browser's wording and Node's.
    expect(wasAborted(new DOMException("signal is aborted without reason", "AbortError"))).toBe(
      true,
    );

    const nodeStyle = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });

    expect(wasAborted(nodeStyle)).toBe(true);

    // A server that answered, badly, is the caller's story to tell.
    expect(wasAborted(new Error("the server answered 500"))).toBe(false);
    expect(wasAborted("the server answered 500")).toBe(false);
    expect(wasAborted(null)).toBe(false);
    expect(wasAborted(undefined)).toBe(false);
  });
});

describe("a loop driven by something other than the clock", () => {
  /**
   * Held on an object so a call after the subscribe callback isn't narrowed
   * back to null by the compiler.
   */
  type Held = { run: (() => void) | null };

  const held = (): Held => ({ run: null });

  test("a nudge reads now, and the interval still covers a silent socket", async () => {
    const fake = clock();
    const recorded = reads(() => Promise.resolve());
    const nudge = held();

    const stop = startPoll(recorded.task, {
      everyMs: 15_000,
      timers: fake.timers,
      subscribe: (run) => {
        nudge.run = run;

        return () => {
          nudge.run = null;
        };
      },
    });

    await fake.flush();
    expect(recorded.signals).toHaveLength(1);

    // A nudge does not wait out the interval, which is the whole point.
    nudge.run?.();
    await fake.flush();
    expect(recorded.signals).toHaveLength(2);

    // And the interval is still there for a socket that died quietly.
    await fake.advance(15_000);
    expect(recorded.signals).toHaveLength(3);

    stop();
    // Stopping unsubscribes, so a socket outliving the loop can't drive a read
    // into a gone component.
    expect(nudge.run).toBeNull();
  });

  test("a nudge arriving mid-read is dropped, not queued behind it", async () => {
    const fake = clock();
    const recorded = reads(never);
    const nudge = held();

    const stop = startPoll(recorded.task, {
      everyMs: 15_000,
      timeoutMs: 600_000,
      timers: fake.timers,
      subscribe: (run) => {
        nudge.run = run;

        return () => {};
      },
    });

    await fake.flush();
    expect(recorded.signals).toHaveLength(1);

    // The first read never settles. Three nudges arrive against it.
    nudge.run?.();
    nudge.run?.();
    nudge.run?.();
    await fake.flush();

    // One read at a time whoever asks: a nudge gets the same guard as a tick,
    // so a burst of frames can't pile reads against the six-connection budget.
    expect(recorded.signals).toHaveLength(1);
    stop();
  });
});
