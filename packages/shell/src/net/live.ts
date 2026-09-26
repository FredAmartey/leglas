/**
 * The server telling the interface that something changed, so loops needn't ask
 * on a timer: three of them made an idle tab send 100 requests a minute (108KB,
 * nearly all answered "no") and left a newly registered direction up to three
 * seconds from showing.
 *
 * The server says when and the shell keeps its reads: each frame names a kind
 * and nothing else. Pushing state instead would put a second copy on the wire
 * to keep in agreement. Each loop keeps a slow fallback interval, because a
 * dead socket would otherwise leave a rail that looks right and silently stops
 * updating. Websockets don't count against the browser's six HTTP/1.1
 * connections per origin, which the API and every preview iframe share.
 */

/**
 * What a frame can name. Annotations aren't a kind: they're read with the queue
 * on one beat, and their own kind would split that pair into two channels
 * against the connection budget. `update` earned a kind because the server
 * knows each step of an update, and without it the interface polled once a
 * second through a package install.
 */
import { isJsonRecord, isString, parseJson } from "../json.js";
import type { TimerHandle } from "./timers.js";

export type LiveChange = (typeof CHANGES)[number];

/**
 * How long a loop waits with no nudge. The fallback, not the pace: while the
 * socket is up every change arrives as a frame. Fifteen seconds takes an idle
 * tab from 100 reads a minute to four.
 */
export const FALLBACK_MS = 15_000;

/**
 * `share` is its own read on its own beat (tunnel up, viewer arriving), only
 * while a share exists; folding it into `config` would re-read the rail per
 * viewer count. `generation` nudges on every step of a job, only while the
 * feature is on. `LiveChange` is read off this list.
 */
const CHANGES = ["config", "requests", "health", "share", "update", "generation"] as const;

export function isLiveChange(value: unknown): value is LiveChange {
  return CHANGES.some((change) => change === value);
}

/** The kind a frame names, or null for anything this does not recognise. */
export function changeFrom(frame: string): LiveChange | null {
  try {
    const parsed = parseJson(frame);

    if (!isJsonRecord(parsed)) return null;
    const changed = parsed.changed;

    return isLiveChange(changed) ? changed : null;
  } catch {
    // An unreadable frame is ignored; the fallback covers it.
    return null;
  }
}

/**
 * How long to wait before redialling after this many failures. The first retry
 * is quick, since a dev server restart or a quick Leglas restart is the usual
 * cause; it doubles to a ceiling, so a Leglas gone for the afternoon is dialled
 * twice a minute. No jitter: one tab and a local server have no herd to spread.
 */
export const FIRST_RETRY_MS = 250;

export const MAX_RETRY_MS = 30_000;

export function retryDelay(attempt: number): number {
  if (attempt <= 0) return FIRST_RETRY_MS;

  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

/** Only what a message carries. A frame is text; anything else on the wire is dropped. */
export type LiveEvent = { data?: string };

/** The smallest shape a real WebSocket satisfies, so a test can drive one by hand. */
export type LiveSocket = {
  addEventListener(
    type: "message" | "open" | "close" | "error",
    listener: (event: LiveEvent) => void,
  ): void;
  close(): void;
};

export type LiveOptions = {
  /** Open a socket. Injected so tests never need a server. */
  connect?: (url: string) => LiveSocket;
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  /** Where to dial. Defaults to this page's origin, as ws or wss. */
  url?: string;
};

export type Live = {
  /** Ask to hear about one kind. Returns the unsubscribe. */
  on(change: LiveChange, listener: () => void): () => void;
  /** Whether a socket is open right now. For the report, and for tests. */
  readonly connected: boolean;
  stop(): void;
};

function defaultUrl(): string {
  const { host, protocol } = window.location;

  return `${protocol === "https:" ? "wss" : "ws"}://${host}/leglas/api/live`;
}

/**
 * The browser's socket through the shape above. Only text data is passed on; a
 * binary frame carries nothing.
 */
function browserSocket(url: string): LiveSocket {
  const socket = new WebSocket(url);

  return {
    addEventListener: (type, listener) =>
      socket.addEventListener(type, (event) => {
        listener("data" in event && isString(event.data) ? { data: event.data } : {});
      }),
    close: () => socket.close(),
  };
}

/**
 * The page's one connection, shared by every loop and never stopped, like the
 * document. Held here, not in a component, so React's development double-mount
 * can't open a second socket. Tests call `startLive` with an injected socket
 * instead.
 */
let shared: Live | null = null;

export function liveConnection(): Live {
  shared ??= startLive();

  return shared;
}

/**
 * Holds one socket open, redialling when it drops, and hands each frame to
 * whoever asked for its kind. One socket for the whole interface: frames are
 * tiny and kinds few.
 */
export function startLive(options: LiveOptions = {}): Live {
  const connect = options.connect ?? browserSocket;
  const setLater = options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearLater = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));

  const listeners = new Map<LiveChange, Set<() => void>>();
  let socket: LiveSocket | null = null;
  let connected = false;
  let attempt = 0;
  let retry: TimerHandle | null = null;
  let stopped = false;

  const dial = () => {
    if (stopped) return;
    let opened: LiveSocket;

    try {
      opened = connect(options.url ?? defaultUrl());
    } catch {
      // A URL the browser won't take won't start working, but the loops keep
      // reading, so this stays quiet and retries on the backoff.
      return schedule();
    }

    socket = opened;

    opened.addEventListener("open", () => {
      if (stopped) return;
      connected = true;
      // Only a socket that opened resets the backoff; counting a failed
      // handshake would turn a refusing server into a tight redial loop.
      attempt = 0;
    });

    opened.addEventListener("message", (event) => {
      if (event.data === undefined) return;
      const change = changeFrom(event.data);

      if (change === null) return;

      for (const listener of listeners.get(change) ?? []) listener();
    });

    const gone = () => {
      if (socket !== opened) return;
      connected = false;
      socket = null;
      schedule();
    };

    opened.addEventListener("close", gone);
    opened.addEventListener("error", gone);
  };

  const schedule = () => {
    if (stopped || retry !== null) return;
    const wait = retryDelay(attempt);
    attempt += 1;
    retry = setLater(() => {
      retry = null;
      dial();
    }, wait);
  };

  dial();

  return {
    on(change, listener) {
      const group = listeners.get(change) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(change, group);

      return () => {
        group.delete(listener);

        if (group.size === 0) listeners.delete(change);
      };
    },
    get connected() {
      return connected;
    },
    stop() {
      stopped = true;
      connected = false;

      if (retry !== null) clearLater(retry);
      retry = null;
      listeners.clear();
      const open = socket;
      socket = null;

      try {
        open?.close();
      } catch {
        // Already gone.
      }
    },
  };
}
