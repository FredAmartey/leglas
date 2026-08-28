/**
 * The server telling the interface that something changed.
 *
 * Three loops used to ask, on a timer, whether anything had happened: the
 * config every three seconds, the queue and its annotations every two, the
 * dev server's health every three. Measured on a real project, a tab sitting
 * idle with nobody touching it made 100 requests a minute and moved 108KB,
 * almost all of it answered "no". It also set the tail of the send loop,
 * because a direction an agent had just registered waited up to three
 * seconds for the next tick to notice it.
 *
 * So the server says when, and the shell keeps its reads. Every frame names
 * a kind and carries nothing else; the reader then does the read it already
 * knew how to do. Pushing the state instead would put a second copy of it on
 * the wire and leave two things to keep in agreement, which is the usual way
 * this goes wrong.
 *
 * The loops do not go away. Each keeps a slow interval as a fallback, so a
 * socket that dies quietly costs latency rather than correctness. That
 * direction matters: polling fails invisibly and heals on the next tick,
 * while a dead socket leaves a rail that looks entirely correct and silently
 * stops updating, which is the worse of the two failures by far.
 *
 * A websocket is also free of the budget the reads compete for. The browser
 * allows six HTTP/1.1 connections per origin, and the shell shares that one
 * origin with the API and with every preview iframe; websockets are counted
 * separately, so this relieves that pressure rather than adding to it.
 */

/**
 * What a frame can name.
 *
 * Three kinds, and annotations are deliberately not one of them. The queue
 * and the annotations are read on one beat, in that order, so the pair costs
 * one socket instead of two. Giving annotations a kind of their own would
 * turn that single beat into two independent channels and undo the reason it
 * is a pair, against the same six-connection budget above. If a fourth kind
 * is ever wanted, that is the argument to answer first.
 */
export type LiveChange = "config" | "requests" | "health";

/**
 * How long a loop waits when nothing has nudged it.
 *
 * This is the fallback, not the pace. While the socket is up nothing waits
 * on it, because every change arrives as a frame; it exists so a socket that
 * died quietly costs the interface some latency instead of leaving it
 * silently wrong. Fifteen seconds is far slower than the two and three it
 * replaces and still fast enough that nobody sits looking at a stale rail,
 * and it takes an idle tab from 100 reads a minute to four.
 */
export const FALLBACK_MS = 15_000;

const CHANGES: readonly LiveChange[] = ["config", "requests", "health"];

export function isLiveChange(value: unknown): value is LiveChange {
  return typeof value === "string" && (CHANGES as readonly string[]).includes(value);
}

/** The kind a frame names, or null for anything this does not recognise. */
export function changeFrom(data: unknown): LiveChange | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    const changed = Reflect.get(parsed, "changed");
    return isLiveChange(changed) ? changed : null;
  } catch {
    // A frame we cannot read is a frame we ignore. The fallback covers it.
    return null;
  }
}

/**
 * How long to wait before dialling again, given how many attempts have
 * failed in a row.
 *
 * The first retry is quick, because much of what closes this socket is a dev
 * server restart or a Leglas that came straight back, and waiting seconds
 * for those would be the interface sulking. It doubles from there to a
 * ceiling, so a Leglas that is gone for the afternoon is dialled twice a
 * minute rather than continuously.
 *
 * Deliberately without jitter: this is one browser tab talking to a server
 * on the same machine, so there is no thundering herd to spread out, and a
 * predictable delay is easier to test and to reason about.
 */
export const FIRST_RETRY_MS = 250;
export const MAX_RETRY_MS = 30_000;

export function retryDelay(attempt: number): number {
  if (attempt <= 0) return FIRST_RETRY_MS;
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

/** Only what a message carries; every other event carries nothing we read. */
export type LiveEvent = { data?: unknown };

/**
 * The smallest shape a real WebSocket already satisfies, so a test can hand
 * over something it drives by hand without standing up a server.
 */
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
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
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
 * The one connection this page has.
 *
 * A page-lifetime resource, like the document: every loop shares it, and it
 * is never stopped because there is nothing after the page to stop it for.
 * Held here rather than in a component so React's development double-mount
 * cannot open a second socket and leak the first, and so nothing has to be
 * threaded through a component tree to reach the loops that want it.
 *
 * Tests call `startLive` directly with an injected socket and never touch
 * this.
 */
let shared: Live | null = null;

export function liveConnection(): Live {
  shared ??= startLive();
  return shared;
}

/**
 * Hold one socket open, redialling when it goes, and hand each frame to
 * whoever asked for that kind.
 *
 * One socket for the whole interface rather than one per loop: the frames
 * are tiny and the kinds are few, so a second connection would buy nothing
 * and spend a connection.
 */
export function startLive(options: LiveOptions = {}): Live {
  const connect = options.connect ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);
  const setLater = options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearLater = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as never));

  const listeners = new Map<LiveChange, Set<() => void>>();
  let socket: LiveSocket | null = null;
  let connected = false;
  let attempt = 0;
  let retry: unknown = null;
  let stopped = false;

  const dial = () => {
    if (stopped) return;
    let opened: LiveSocket;
    try {
      opened = connect(options.url ?? defaultUrl());
    } catch {
      // A URL the browser will not take is not going to start working, but
      // the loops keep reading on their own, so this stays quiet and tries
      // again on the backoff like any other failure.
      return schedule();
    }
    socket = opened;

    opened.addEventListener("open", () => {
      if (stopped) return;
      connected = true;
      // Only a socket that actually opened resets the backoff. Counting a
      // dial that failed during the handshake as success would turn a
      // server refusing connections into a tight redial loop.
      attempt = 0;
    });

    opened.addEventListener("message", (event) => {
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
