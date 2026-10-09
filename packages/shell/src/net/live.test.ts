// @vitest-environment happy-dom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The server's side of the protocol. Its module imports Node built-ins, hence
// the reference above.
import type { LiveChange as ServerChange } from "../../../server/src/live.js";

import {
  FIRST_RETRY_MS,
  MAX_RETRY_MS,
  changeFrom,
  isLiveChange,
  retryDelay,
  startLive,
} from "./live.js";

type Listener = (event: { data?: unknown }) => void;

/** The browser's socket, as a test drives it by hand. */
class FakeSocket {
  closes = 0;
  private readonly handlers = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closes += 1;
  }
}

/** Every socket dialled, in order. */
let sockets: FakeSocket[] = [];

const frame = (changed: string) => ({ data: JSON.stringify({ changed }) });

// Backoff is timers, faked so it costs no wall clock.
beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
    const live = startLive();
    const config = vi.fn();
    const requests = vi.fn();
    live.on("config", config);
    live.on("requests", requests);
    expect(sockets[0]?.url).toMatch(/^ws:\/\/[^/]*\/leglas\/api\/live$/);
    sockets[0]?.emit("open");

    sockets[0]?.emit("message", frame("requests"));
    expect(requests).toHaveBeenCalledOnce();
    expect(config).not.toHaveBeenCalled();

    sockets[0]?.emit("message", frame("config"));
    expect(config).toHaveBeenCalledOnce();

    // Anything unreadable is ignored, not thrown: the fallback read covers it
    // and a bad frame mustn't kill the socket.
    sockets[0]?.emit("message", { data: "{" });
    sockets[0]?.emit("message", frame("annotations"));
    expect(config).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();

    live.stop();
  });

  test("unsubscribing stops one listener without touching the others", () => {
    const live = startLive();
    const first = vi.fn();
    const second = vi.fn();
    const off = live.on("config", first);
    live.on("config", second);

    off();
    sockets[0]?.emit("message", frame("config"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    live.stop();
  });

  test("redials on a backoff when the socket goes, and resets once one opens", () => {
    const live = startLive();

    expect(sockets).toHaveLength(1);
    sockets[0]?.emit("open");
    expect(live.connected).toBe(true);

    // It goes. Nothing is dialled until the delay has passed.
    sockets[0]?.emit("close");
    expect(live.connected).toBe(false);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(FIRST_RETRY_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // That one never opens, so the next wait is longer.
    sockets[1]?.emit("close");
    vi.advanceTimersByTime(FIRST_RETRY_MS * 2 - 1);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    // A socket that actually opens resets the backoff, so a server restarting
    // twice isn't punished for the first.
    sockets[2]?.emit("open");
    sockets[2]?.emit("close");
    vi.advanceTimersByTime(FIRST_RETRY_MS);
    expect(sockets).toHaveLength(4);

    // An error is a close: browsers commonly fire error and then close for one
    // failure, and it redials once, not twice.
    sockets[3]?.emit("error");
    sockets[3]?.emit("close");
    vi.advanceTimersByTime(MAX_RETRY_MS);
    expect(sockets).toHaveLength(5);

    live.stop();
  });

  test("a dial that throws is treated as a failure, not an exception", () => {
    let attempts = 0;

    vi.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor(url: string) {
          attempts += 1;

          if (attempts === 1) throw new Error("refused");
          super(url);
        }
      },
    );

    const live = startLive();

    expect(attempts).toBe(1);
    expect(live.connected).toBe(false);
    vi.advanceTimersByTime(FIRST_RETRY_MS);
    expect(attempts).toBe(2);
    live.stop();
  });

  test("stopping closes the socket and cancels a pending redial", () => {
    // Stopped while its socket is open, it closes that socket.
    const open = startLive();
    sockets[0]?.emit("open");
    open.stop();
    expect(sockets[0]?.closes).toBe(1);
    expect(open.connected).toBe(false);

    // Stopped while waiting to redial, it never dials again.
    const redialling = startLive();
    const heard = vi.fn();
    redialling.on("config", heard);
    sockets[1]?.emit("open");
    sockets[1]?.emit("close");
    expect(vi.getTimerCount()).toBe(1);

    redialling.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MAX_RETRY_MS * 2);
    expect(sockets).toHaveLength(2);
    // A frame arriving from a socket nobody closed in time reaches nobody.
    sockets[1]?.emit("message", frame("config"));
    expect(heard).not.toHaveBeenCalled();
  });
});
