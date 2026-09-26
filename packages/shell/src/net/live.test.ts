/// <reference types="node" />
import { describe, expect, test, vi } from "vitest";

// The server's side of the protocol. Its module imports Node built-ins, hence
// the reference above.
import type { LiveChange as ServerChange } from "../../../server/src/live.js";
import type { TimerHandle } from "./timers.js";

import {
  FIRST_RETRY_MS,
  MAX_RETRY_MS,
  changeFrom,
  isLiveChange,
  retryDelay,
  startLive,
  type LiveEvent,
  type LiveSocket,
} from "./live.js";

/** A socket a test drives by hand, standing in for the browser's. */
class FakeSocket implements LiveSocket {
  closes = 0;
  private readonly handlers = new Map<string, Array<(event: LiveEvent) => void>>();

  addEventListener(type: string, listener: (event: LiveEvent) => void): void {
    const group = this.handlers.get(type) ?? [];
    group.push(listener);
    this.handlers.set(type, group);
  }

  emit(type: string, event: LiveEvent = {}): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closes += 1;
  }
}

/** Timers a test advances itself, so backoff costs no wall clock. */
function manualTimers() {
  const pending = new Map<TimerHandle, { at: number; callback: () => void }>();
  let now = 0;
  let next = 1;

  return {
    setTimeout: (callback: () => void, ms: number) => {
      const handle = next;
      next += 1;
      pending.set(handle, { at: now + ms, callback });

      return handle;
    },
    clearTimeout: (handle: TimerHandle) => {
      pending.delete(handle);
    },
    advance(ms: number) {
      now += ms;

      for (const [handle, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(handle);
          entry.callback();
        }
      }
    },
    get waiting() {
      return pending.size;
    },
  };
}

/**
 * Every kind the server nudges with, keyed by the server's own type so the two
 * lists can't drift without failing `pnpm typecheck` (the shell's tsconfig
 * includes its tests).
 */
const SENT = {
  config: true,
  requests: true,
  health: true,
  share: true,
  update: true,
  generation: true,
} satisfies Record<ServerChange, true>;

describe("what a frame can say", () => {
  test.each(Object.keys(SENT))("reads %s", (kind) => {
    expect(changeFrom(JSON.stringify({ changed: kind }))).toBe(kind);
  });

  test("refuses everything else", () => {
    // Annotations ride "requests" on purpose, so the queue and its notes cost
    // one socket, not two.
    expect(changeFrom(JSON.stringify({ changed: "annotations" }))).toBeNull();
    expect(isLiveChange("annotations")).toBe(false);

    expect(changeFrom("not json")).toBeNull();
    expect(changeFrom(JSON.stringify(["config"]))).toBeNull();
    expect(changeFrom(JSON.stringify({ changed: 3 }))).toBeNull();
  });
});

describe("retryDelay", () => {
  test("starts quick, doubles, and stops at the ceiling", () => {
    expect(retryDelay(0)).toBe(FIRST_RETRY_MS);
    expect(retryDelay(1)).toBe(FIRST_RETRY_MS * 2);
    expect(retryDelay(2)).toBe(FIRST_RETRY_MS * 4);
    expect(retryDelay(40)).toBe(MAX_RETRY_MS);
    // A Leglas gone for the afternoon is dialled twice a minute, not
    // continuously.
    expect(retryDelay(99)).toBe(MAX_RETRY_MS);
  });
});

describe("startLive", () => {
  test("hands each frame to whoever asked for that kind, and nobody else", () => {
    const socket = new FakeSocket();
    const live = startLive({ connect: () => socket, url: "ws://x/live" });
    const config = vi.fn();
    const requests = vi.fn();
    live.on("config", config);
    live.on("requests", requests);
    socket.emit("open");

    socket.emit("message", { data: JSON.stringify({ changed: "requests" }) });
    expect(requests).toHaveBeenCalledOnce();
    expect(config).not.toHaveBeenCalled();

    socket.emit("message", { data: JSON.stringify({ changed: "config" }) });
    expect(config).toHaveBeenCalledOnce();

    // Anything unreadable is ignored, not thrown: the fallback read covers it
    // and a bad frame mustn't kill the socket.
    socket.emit("message", { data: "{" });
    socket.emit("message", { data: JSON.stringify({ changed: "annotations" }) });
    expect(config).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();

    live.stop();
  });

  test("unsubscribing stops one listener without touching the others", () => {
    const socket = new FakeSocket();
    const live = startLive({ connect: () => socket, url: "ws://x/live" });
    const first = vi.fn();
    const second = vi.fn();
    const off = live.on("config", first);
    live.on("config", second);

    off();
    socket.emit("message", { data: JSON.stringify({ changed: "config" }) });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    live.stop();
  });

  test("redials on a backoff when the socket goes, and resets once one opens", () => {
    const sockets: FakeSocket[] = [];
    const timers = manualTimers();

    const live = startLive({
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);

        return socket;
      },
      url: "ws://x/live",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    expect(sockets).toHaveLength(1);
    sockets[0]?.emit("open");
    expect(live.connected).toBe(true);

    // It goes. Nothing is dialled until the delay has passed.
    sockets[0]?.emit("close");
    expect(live.connected).toBe(false);
    expect(sockets).toHaveLength(1);
    timers.advance(FIRST_RETRY_MS - 1);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);

    // That one never opens, so the next wait is longer.
    sockets[1]?.emit("close");
    timers.advance(FIRST_RETRY_MS * 2 - 1);
    expect(sockets).toHaveLength(2);
    timers.advance(1);
    expect(sockets).toHaveLength(3);

    // A socket that actually opens resets the backoff, so a server restarting
    // twice isn't punished for the first.
    sockets[2]?.emit("open");
    sockets[2]?.emit("close");
    timers.advance(FIRST_RETRY_MS);
    expect(sockets).toHaveLength(4);

    live.stop();
  });

  test("a dial that throws is treated as a failure, not an exception", () => {
    const timers = manualTimers();
    let attempts = 0;
    const socket = new FakeSocket();

    const live = startLive({
      connect: () => {
        attempts += 1;

        if (attempts === 1) throw new Error("refused");

        return socket;
      },
      url: "ws://x/live",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    expect(attempts).toBe(1);
    expect(live.connected).toBe(false);
    timers.advance(FIRST_RETRY_MS);
    expect(attempts).toBe(2);
    live.stop();
  });

  test("an error is a close: it redials once, not twice", () => {
    const sockets: FakeSocket[] = [];
    const timers = manualTimers();

    const live = startLive({
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);

        return socket;
      },
      url: "ws://x/live",
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    // Browsers commonly fire error and then close for one failure.
    sockets[0]?.emit("error");
    sockets[0]?.emit("close");
    timers.advance(MAX_RETRY_MS);

    expect(sockets).toHaveLength(2);
    live.stop();
  });

  test("stopping closes the socket and cancels a pending redial", () => {
    const sockets: FakeSocket[] = [];
    const timers = manualTimers();

    const start = () =>
      startLive({
        connect: () => {
          const socket = new FakeSocket();
          sockets.push(socket);

          return socket;
        },
        url: "ws://x/live",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      });

    // Stopped while its socket is open, it closes that socket.
    const open = start();
    sockets[0]?.emit("open");
    open.stop();
    expect(sockets[0]?.closes).toBe(1);
    expect(open.connected).toBe(false);

    // Stopped while waiting to redial, it never dials again.
    const redialling = start();
    const heard = vi.fn();
    redialling.on("config", heard);
    sockets[1]?.emit("open");
    sockets[1]?.emit("close");
    expect(timers.waiting).toBe(1);

    redialling.stop();

    expect(timers.waiting).toBe(0);
    timers.advance(MAX_RETRY_MS * 2);
    expect(sockets).toHaveLength(2);
    // A frame arriving from a socket nobody closed in time reaches nobody.
    sockets[1]?.emit("message", { data: JSON.stringify({ changed: "config" }) });
    expect(heard).not.toHaveBeenCalled();
  });
});
