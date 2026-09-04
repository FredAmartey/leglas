import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const LIVE_PATH = "/leglas/api/live";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Annotations deliberately ride `requests`: the shell reads both on one beat,
 * keeping them on one socket against the six-connection-per-origin budget.
 * A separate `annotations` kind would split that pair into independent channels.
 */
export type LiveChange = "config" | "requests" | "health" | "share";

export type LiveHub = {
  /** Tell every listening interface that something changed. */
  nudge(change: LiveChange): void;
  /** Take an upgrade if it is ours. Returns false for anything else. */
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options?: { viewer?: boolean },
  ): boolean;
  close(): Promise<void>;
  /** Interfaces currently listening. For tests and for the idle probe. */
  readonly listening: number;
  /** Listening interfaces that entered through the share listener. */
  readonly viewers: number;
};

type Listener = {
  socket: Duplex;
  buffered: Buffer;
  viewer: boolean;
};

/** Encode one unmasked server frame, including all three payload length forms. */
export function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  let header: Buffer;

  if (body.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body], header.length + body.length);
}

/**
 * Turn a burst of changes into one nudge each.
 *
 * A single save often reaches a watcher as several events, and a request
 * being answered rewrites the queue and the annotations together, so without
 * this the shell would be told to read three times for one thing happening.
 *
 * The timers are injectable because the behaviour worth proving is exactly
 * the one real time makes untestable: that two changes inside the window
 * produce one nudge and two outside it produce two. Asserting that against a
 * live watcher measures how quickly the operating system delivered an event,
 * which is not a property of this code and fails on a loaded machine.
 */
export type Coalescer = {
  schedule(change: LiveChange): void;
  close(): void;
};

export const LIVE_DEBOUNCE_MS = 50;

export function createCoalescer(
  emit: (change: LiveChange) => void,
  options: {
    windowMs?: number;
    setTimeout?: (callback: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  } = {},
): Coalescer {
  const windowMs = options.windowMs ?? LIVE_DEBOUNCE_MS;
  const setLater =
    options.setTimeout ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
  const clearLater =
    options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // One pending nudge per kind, so a burst of config changes cannot delay a
  // requests nudge that arrived in the middle of it.
  const pending = new Map<LiveChange, unknown>();
  let closed = false;

  return {
    schedule(change) {
      if (closed) return;
      const waiting = pending.get(change);
      if (waiting !== undefined) clearLater(waiting);
      pending.set(
        change,
        setLater(() => {
          pending.delete(change);
          if (!closed) emit(change);
        }, windowMs),
      );
    },
    close() {
      closed = true;
      for (const handle of pending.values()) clearLater(handle);
      pending.clear();
    },
  };
}

export function createLiveHub(
  options: { now?: () => number; onViewers?: (count: number) => void } = {},
): LiveHub {
  const listeners = new Set<Listener>();
  let viewers = 0;

  const drop = (listener: Listener): void => {
    if (!listeners.delete(listener) || !listener.viewer) return;
    viewers = Math.max(0, viewers - 1);
    options.onViewers?.(viewers);
  };

  const write = (listener: Listener, opcode: number, payload: Buffer | string): boolean => {
    if (listener.socket.destroyed || !listener.socket.writable) {
      drop(listener);
      return false;
    }
    try {
      listener.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      drop(listener);
      listener.socket.destroy();
      return false;
    }
  };

  const read = (listener: Listener, chunk: Buffer | string): void => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    listener.buffered =
      listener.buffered.length === 0
        ? incoming
        : Buffer.concat([listener.buffered, incoming]);

    while (listener.buffered.length >= 2) {
      const first = listener.buffered[0] ?? 0;
      const second = listener.buffered[1] ?? 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (listener.buffered.length < 4) return;
        length = listener.buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (listener.buffered.length < 10) return;
        const wide = listener.buffered.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
          drop(listener);
          listener.socket.destroy();
          return;
        }
        length = Number(wide);
        offset = 10;
      }

      const masked = (second & 0x80) !== 0;
      if (!masked) {
        drop(listener);
        listener.socket.destroy();
        return;
      }
      if (listener.buffered.length < offset + 4 + length) return;

      const mask = listener.buffered.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(listener.buffered.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
      listener.buffered = listener.buffered.subarray(offset + length);

      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        write(listener, 0x8, payload);
        drop(listener);
        listener.socket.destroy();
        return;
      }
      if (opcode === 0x9) write(listener, 0xa, payload);
      // Text, binary, continuation and pong frames from the client carry no
      // protocol information for this one-way channel and are ignored.
    }
  };

  return {
    nudge: (change) => {
      if (listeners.size === 0) return;
      const frame = encodeFrame(0x1, JSON.stringify({ changed: change }));
      for (const listener of [...listeners]) {
        if (listener.socket.destroyed || !listener.socket.writable) {
          drop(listener);
          continue;
        }
        try {
          listener.socket.write(frame);
        } catch {
          drop(listener);
          listener.socket.destroy();
        }
      }
    },
    upgrade: (req, socket, head, upgradeOptions = {}) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (req.method !== "GET" || path !== LIVE_PATH) return false;

      const upgrade = req.headers.upgrade;
      const key = req.headers["sec-websocket-key"];
      if (
        typeof upgrade !== "string" ||
        upgrade.toLowerCase() !== "websocket" ||
        typeof key !== "string" ||
        key.trim() === ""
      ) {
        socket.destroy();
        return false;
      }

      const accept = createHash("sha1")
        .update(key + WEBSOCKET_GUID)
        .digest("base64");
      try {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      } catch {
        socket.destroy();
        return false;
      }

      const listener: Listener = {
        socket,
        buffered: Buffer.alloc(0),
        viewer: upgradeOptions.viewer === true,
      };
      listeners.add(listener);
      if (listener.viewer) {
        viewers += 1;
        options.onViewers?.(viewers);
      }
      socket.on("data", (chunk: Buffer | string) => read(listener, chunk));
      socket.once("error", () => drop(listener));
      socket.once("end", () => drop(listener));
      socket.once("close", () => drop(listener));
      if (head.length > 0) read(listener, head);
      return true;
    },
    close: async () => {
      for (const listener of [...listeners]) {
        write(listener, 0x8, Buffer.alloc(0));
        drop(listener);
        listener.socket.destroy();
      }
    },
    get listening() {
      return listeners.size;
    },
    get viewers() {
      return viewers;
    },
  };
}
