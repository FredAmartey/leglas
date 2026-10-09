import { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";
import { ClientRequest, IncomingMessage } from "node:http";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Loaded into the Leglas CLI with `node --import` by bench/run.ts. Appends one
 * JSON line per event to the file named in LEGLAS_BENCH_EVENTS, timed by this
 * process's own clock, so the runner never compares two processes' clocks.
 *
 * Every message is parsed through a guard (Node types them as unknown) and every
 * subscriber catches everything: a throw here would surface as an uncaught
 * exception inside Leglas and change what is being measured.
 */

export type ProbeKind = "spawn" | "exit" | "request" | "upstream";

export type ProbeEvent = {
  /** Milliseconds since this process started. */
  t: number;
  kind: ProbeKind;
  /** A command's basename, or a method and a URL. */
  what: string;
  /** Set on spawn and exit, which pair up by it. */
  pid?: number;
};

const target = process.env.LEGLAS_BENCH_EVENTS;

function write(kind: ProbeKind, what: string, pid?: number): void {
  if (target === undefined || target === "") return;
  const event: ProbeEvent = { t: Math.round(performance.now() * 10) / 10, kind, what };

  if (pid !== undefined) event.pid = pid;

  try {
    appendFileSync(target, `${JSON.stringify(event)}\n`);
  } catch {
    // A lost line shows up as a wrong count, which the runner reports.
  }
}

function hasChild(message: unknown): message is { process: ChildProcess } {
  return (
    typeof message === "object" &&
    message !== null &&
    "process" in message &&
    message.process instanceof ChildProcess
  );
}

function hasIncoming(message: unknown): message is { request: IncomingMessage } {
  return (
    typeof message === "object" &&
    message !== null &&
    "request" in message &&
    message.request instanceof IncomingMessage
  );
}

function hasClientRequest(message: unknown): message is { request: ClientRequest } {
  return (
    typeof message === "object" &&
    message !== null &&
    "request" in message &&
    message.request instanceof ClientRequest
  );
}

/** undici's request is internal to Node, so it is read by the three fields used. */
function hasFetch(
  message: unknown,
): message is { request: { method: string; origin: string; path: string } } {
  if (typeof message !== "object" || message === null || !("request" in message)) return false;
  const request = message.request;

  return (
    typeof request === "object" &&
    request !== null &&
    "method" in request &&
    typeof request.method === "string" &&
    "origin" in request &&
    typeof request.origin === "string" &&
    "path" in request &&
    typeof request.path === "string"
  );
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

// Fires from the ChildProcess constructor, before the command is known; the
// child's own spawn event carries the file and pid, and a spawn that fails never
// emits it, so only processes that started are written.
subscribe("child_process", (message) => {
  try {
    if (!hasChild(message)) return;
    const child = message.process;
    let started = false;

    child.once("spawn", () => {
      started = true;
      write("spawn", basename(child.spawnfile), child.pid);
    });
    child.once("exit", () => {
      if (started) write("exit", basename(child.spawnfile), child.pid);
    });
  } catch {
    // Unreadable message: nothing written.
  }
});

// Upgrades never reach this channel, so the live socket is counted page side.
subscribe("http.server.request.start", (message) => {
  try {
    if (!hasIncoming(message)) return;
    write("request", `${message.request.method ?? "GET"} ${message.request.url ?? "/"}`);
  } catch {
    // Unreadable message: nothing written.
  }
});

subscribe("http.client.request.start", (message) => {
  try {
    if (!hasClientRequest(message)) return;
    const { request } = message;
    const host = request.getHeader("host");
    const authority = isText(host) ? host : request.host;
    write("upstream", `${request.method} ${request.protocol}//${authority}${request.path}`);
  } catch {
    // Unreadable message: nothing written.
  }
});

subscribe("undici:request:create", (message) => {
  try {
    if (!hasFetch(message)) return;
    const { request } = message;
    write("upstream", `${request.method} ${request.origin}${request.path}`);
  } catch {
    // Unreadable message: nothing written.
  }
});
