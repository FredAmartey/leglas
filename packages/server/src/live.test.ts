import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";

import {
  LIVE_DEBOUNCE_MS,
  createCoalescer,
  createLiveHub,
  encodeFrame,
} from "./live.js";

class RecordingSocket extends Duplex {
  readonly writes: Buffer[] = [];

  _read(): void {}

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    callback();
  }
}

function request(key: string | undefined = "dGhlIHNhbXBsZSBub25jZQ=="): IncomingMessage {
  return {
    method: "GET",
    url: "/leglas/api/live",
    headers: {
      upgrade: "websocket",
      ...(key === undefined ? {} : { "sec-websocket-key": key }),
    },
  } as IncomingMessage;
}

function requestWithoutKey(): IncomingMessage {
  return {
    method: "GET",
    url: "/leglas/api/live",
    headers: { upgrade: "websocket" },
  } as IncomingMessage;
}

function listen(hub: ReturnType<typeof createLiveHub>): RecordingSocket {
  const socket = new RecordingSocket();
  expect(hub.upgrade(request(), socket, Buffer.alloc(0))).toBe(true);
  socket.writes.length = 0;
  return socket;
}

function clientFrame(opcode: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const frame = Buffer.alloc(2 + 4 + body.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | body.length;
  mask.copy(frame, 2);
  for (let index = 0; index < body.length; index += 1) {
    frame[6 + index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return frame;
}

describe("createLiveHub", () => {
  test("computes the documented accept value and refuses a missing key", () => {
    const hub = createLiveHub();
    const socket = new RecordingSocket();

    expect(hub.upgrade(request(), socket, Buffer.alloc(0))).toBe(true);
    expect(Buffer.concat(socket.writes).toString()).toContain(
      "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n",
    );

    const refused = new RecordingSocket();
    expect(hub.upgrade(requestWithoutKey(), refused, Buffer.alloc(0))).toBe(false);
    expect(refused.destroyed).toBe(true);
  });

  test("sends the exact config nudge to every listener", () => {
    const hub = createLiveHub();
    const first = listen(hub);
    const second = listen(hub);

    hub.nudge("config");

    const expected = encodeFrame(0x1, '{"changed":"config"}');
    expect(Buffer.concat(first.writes)).toEqual(expected);
    expect(Buffer.concat(second.writes)).toEqual(expected);
  });

  test.each([
    { length: 125, marker: 125, header: 2 },
    { length: 126, marker: 126, header: 4 },
    { length: 65_536, marker: 127, header: 10 },
  ])("encodes a $length byte payload with the right header", ({ length, marker, header }) => {
    const frame = encodeFrame(0x1, Buffer.alloc(length));

    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(marker);
    expect(frame).toHaveLength(header + length);
    if (length === 126) expect(frame.readUInt16BE(2)).toBe(126);
    if (length === 65_536) expect(frame.readBigUInt64BE(2)).toBe(65_536n);
  });

  test("answers a ping with a pong and honours a client close", () => {
    const hub = createLiveHub();
    const socket = listen(hub);

    socket.emit("data", clientFrame(0x9, "still here"));
    expect(Buffer.concat(socket.writes)).toEqual(encodeFrame(0xa, "still here"));
    expect(hub.listening).toBe(1);

    socket.writes.length = 0;
    socket.emit("data", clientFrame(0x8));
    expect(Buffer.concat(socket.writes)).toEqual(encodeFrame(0x8, Buffer.alloc(0)));
    expect(hub.listening).toBe(0);
  });

  test("reaps an errored socket and later nudges are harmless", () => {
    const hub = createLiveHub();
    const socket = listen(hub);

    socket.emit("error", new Error("gone"));

    expect(hub.listening).toBe(0);
    expect(() => hub.nudge("health")).not.toThrow();
  });

  test("close sends close frames and empties the hub", async () => {
    const hub = createLiveHub();
    const first = listen(hub);
    const second = listen(hub);

    await hub.close();

    expect(hub.listening).toBe(0);
    expect(Buffer.concat(first.writes)).toEqual(encodeFrame(0x8, Buffer.alloc(0)));
    expect(Buffer.concat(second.writes)).toEqual(encodeFrame(0x8, Buffer.alloc(0)));
  });
});

describe("createCoalescer", () => {
  /** A clock the test drives, so nothing here depends on real time. */
  function clock() {
    const pending = new Map<number, { at: number; run: () => void }>();
    let now = 0;
    let next = 1;
    return {
      setTimeout: (run: () => void, ms: number) => {
        const handle = next++;
        pending.set(handle, { at: now + ms, run });
        return handle;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
      advance(ms: number) {
        now += ms;
        for (const [handle, entry] of [...pending]) {
          if (entry.at <= now) {
            pending.delete(handle);
            entry.run();
          }
        }
      },
      get waiting() {
        return pending.size;
      },
    };
  }

  test("two changes inside the window are one nudge; outside it, two", () => {
    const emitted: string[] = [];
    const timers = clock();
    const coalescer = createCoalescer((change) => emitted.push(change), {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    // A single save commonly reaches a watcher as several events.
    coalescer.schedule("requests");
    coalescer.schedule("requests");
    expect(emitted).toEqual([]);
    timers.advance(LIVE_DEBOUNCE_MS);
    expect(emitted).toEqual(["requests"]);

    // Far enough apart, they are two separate things happening.
    coalescer.schedule("requests");
    timers.advance(LIVE_DEBOUNCE_MS);
    coalescer.schedule("requests");
    timers.advance(LIVE_DEBOUNCE_MS);
    expect(emitted).toEqual(["requests", "requests", "requests"]);
  });

  test("each kind waits on its own timer", () => {
    const emitted: string[] = [];
    const timers = clock();
    const coalescer = createCoalescer((change) => emitted.push(change), {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    // A burst of config changes must not hold back a requests nudge that
    // arrived in the middle of it.
    coalescer.schedule("config");
    coalescer.schedule("requests");
    coalescer.schedule("config");
    timers.advance(LIVE_DEBOUNCE_MS);

    expect(emitted.slice().sort()).toEqual(["config", "requests"]);
  });

  test("closing drops what is pending and refuses anything after", () => {
    const emitted: string[] = [];
    const timers = clock();
    const coalescer = createCoalescer((change) => emitted.push(change), {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    coalescer.schedule("health");
    coalescer.close();
    timers.advance(LIVE_DEBOUNCE_MS * 10);
    expect(emitted).toEqual([]);
    expect(timers.waiting).toBe(0);

    // A watcher event racing shutdown must not wake a closed hub.
    coalescer.schedule("health");
    timers.advance(LIVE_DEBOUNCE_MS * 10);
    expect(emitted).toEqual([]);
  });
});

