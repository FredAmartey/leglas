import { describe, expect, test } from "vitest";

import { startPoll, wasAborted, type PollTimers } from "./poll.js";

/**
 * A clock the test drives by hand. The poll loop takes its timers as an
 * argument precisely so a test can run ten minutes of polling in a
 * millisecond, and so nothing here depends on real time.
 */
function clock() {
  type Interval = { callback: () => void; every: number; next: number };
  type Timeout = { callback: () => void; at: number };

  let now = 0;
  let handle = 0;
  const intervals = new Map<number, Interval>();
  const timeouts = new Map<number, Timeout>();

  const timers: PollTimers = {
    setInterval: (callback, every) => {
      const id = ++handle;
      intervals.set(id, { callback, every, next: now + every });
      return id;
    },
    clearInterval: (id) => void intervals.delete(id as number),
    setTimeout: (callback, after) => {
      const id = ++handle;
      timeouts.set(id, { callback, at: now + after });
      return id;
    },
    clearTimeout: (id) => void timeouts.delete(id as number),
  };

  // Real timers are untouched by the fake ones, so a genuine zero-delay
  // timeout is the way to let queued promise callbacks run before asserting.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const advance = async (by: number) => {
    const target = now + by;
    // A real timer never fires ahead of a promise callback that is already
    // queued. Draining first keeps the fake honest about that ordering.
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
function reads(task: (signal: AbortSignal) => Promise<unknown>) {
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
    // The bug this loop exists to prevent. A bare setInterval enqueues a read
    // every tick whether or not the last one came back, so a browser whose
    // per-origin socket budget is already spent accumulates reads faster than
    // it can drain them and anything the user clicks queues behind the pile.
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
    // Abandoning has to free the slot as well as the socket. A task that
    // ignores its signal would otherwise hold the loop shut for good.
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
    // behind waiting to abort a signal nobody is holding any more.
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
    // What a real abort looks like coming out of fetch, in both the browser's
    // wording and Node's.
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
   * Held on an object rather than in a variable so a call after the
   * subscribe callback has run is not narrowed back to null by the compiler,
   * which cannot see that the callback already ran.
   */
  const held = () => ({ run: null as (() => void) | null });

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
    // Stopping unsubscribes, so a socket outliving the loop cannot drive a
    // read into a component that is gone.
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

    // One read at a time, whatever does the asking. A nudge is subject to
    // the same guard an interval tick is, so a burst of frames cannot pile
    // reads up against the six-connection budget.
    expect(recorded.signals).toHaveLength(1);
    stop();
  });
});
