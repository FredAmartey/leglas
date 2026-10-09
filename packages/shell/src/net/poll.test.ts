import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startPoll, wasAborted, type PollOptions } from "./poll.js";

// The loop's own timers are faked, so ten minutes of polling take a
// millisecond and nothing depends on real time.
beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

/** Lets settled reads run their callbacks before asserting. */
const flush = () => vi.advanceTimersByTimeAsync(0);

const never = (): Promise<never> => new Promise<never>(() => undefined);

function deferred() {
  let settle!: () => void;
  let fail!: (error: Error) => void;

  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });

  return { promise, settle, fail };
}

/** Starts a loop over `task`, recording the signal each read was handed. */
function start(task: () => Promise<void>, options: Partial<PollOptions> = {}) {
  const signals: AbortSignal[] = [];

  const stop = startPoll(
    (signal) => {
      signals.push(signal);

      return task();
    },
    { everyMs: 2000, timeoutMs: 600_000, ...options },
  );

  return { signals, stop };
}

describe("startPoll", () => {
  test("reads once straight away instead of waiting out the first interval", () => {
    const { signals, stop } = start(() => Promise.resolve());

    expect(signals).toHaveLength(1);
    stop();
  });

  test("never starts a second read while the first is still in flight", async () => {
    // The bug this loop prevents: a bare setInterval enqueues a read every tick
    // whether or not the last returned, so once the per-origin socket budget is
    // spent reads pile up faster than they drain and user clicks queue behind
    // them.
    const { signals, stop } = start(never);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(signals).toHaveLength(1);
    stop();
  });

  test("starts the next read once the last one settles, and a failed one frees the slot too", async () => {
    const [first, second] = [deferred(), deferred()];
    const reads = [first.promise, second.promise];
    let call = 0;
    const { signals, stop } = start(() => reads[call++] ?? Promise.resolve());

    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals).toHaveLength(1);

    first.settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(signals).toHaveLength(2);

    // Not wedging the loop.
    second.fail(new Error("the server went away"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(signals).toHaveLength(3);
    stop();
  });

  test("abandons a read that outlives its deadline, then resumes reading", async () => {
    // Abandoning aborts the read, so its socket comes back, and frees the slot,
    // or a task ignoring its signal holds the loop shut.
    const { signals, stop } = start(never, { timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(9000);
    expect(signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    stop();
  });

  test("a read that comes back in time is left alone", async () => {
    const { signals, stop } = start(() => Promise.resolve(), {
      everyMs: 60_000,
      timeoutMs: 10_000,
    });

    // Its deadline is disarmed as it settles, or every settled read leaves a
    // timer behind: only the interval is left.
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals[0]?.aborted).toBe(false);
    stop();
  });

  test("stopping aborts the read still in flight", () => {
    const { signals, stop } = start(never);

    stop();

    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stopping ends the loop for good, mid-read or between reads, and twice is harmless", async () => {
    // Mid-read, whatever settles after.
    const late = deferred();
    const { signals, stop } = start(() => late.promise);

    stop();
    late.settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(signals).toHaveLength(1);
    expect(() => stop()).not.toThrow();

    // Between reads, which is where most loops are when their pane goes.
    const idle = start(() => Promise.resolve());
    await flush();
    idle.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(idle.signals).toHaveLength(1);
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

  test("a nudge reads now, and the interval still covers a silent socket", async () => {
    const nudge: Held = { run: null };

    const { signals, stop } = start(() => Promise.resolve(), {
      everyMs: 15_000,
      subscribe: (run) => {
        nudge.run = run;

        return () => {
          nudge.run = null;
        };
      },
    });

    await flush();
    expect(signals).toHaveLength(1);

    // A nudge does not wait out the interval, which is the whole point.
    nudge.run?.();
    await flush();
    expect(signals).toHaveLength(2);

    // And the interval is still there for a socket that died quietly.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals).toHaveLength(3);

    stop();
    // Stopping unsubscribes, so a socket outliving the loop can't drive a read
    // into a gone component.
    expect(nudge.run).toBeNull();
  });

  test("a nudge arriving mid-read is dropped, not queued behind it", async () => {
    const nudge: Held = { run: null };

    const { signals, stop } = start(never, {
      everyMs: 15_000,
      subscribe: (run) => {
        nudge.run = run;

        return () => {};
      },
    });

    // The first read never settles. Three nudges arrive against it.
    nudge.run?.();
    nudge.run?.();
    nudge.run?.();
    await flush();

    // One read at a time whoever asks: a nudge gets the same guard as a tick,
    // so a burst of frames can't pile reads against the six-connection budget.
    expect(signals).toHaveLength(1);
    stop();
  });
});
