import { spawn as spawnChild } from "node:child_process";
import { Resolver, lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

import { agentEnvironment, pathLookup } from "./agents.js";

export type TunnelProviderId = "cloudflared" | "ngrok";

export type TunnelState =
  | { status: "none" }
  | {
      status: "starting";
      provider: TunnelProviderId;
      url?: string;
      /**
       * The link has not answered from here within the probe deadline. Not a
       * failure: a quick tunnel's name takes a minute or more to spread, and
       * a resolver that cached the miss holds it longer, so the link is often
       * already working for the person it was sent to while this machine
       * still cannot see it.
       */
      slow?: boolean;
    }
  | { status: "ready"; provider: TunnelProviderId; url: string }
  | { status: "failed"; provider: TunnelProviderId; reason: string; url?: string };

export type RunningTunnel = {
  stop(): Promise<void>;
  /**
   * Declare the link answering on evidence better than the probe's: a viewer
   * has arrived through it. Stops asking and reports `ready`. Nothing
   * happens without a URL to be ready at, or once the tunnel is settled.
   */
  settle(): void;
};

export type TunnelDeps = {
  spawn?: typeof spawnChild;
  probe?: (url: string) => Promise<boolean>;
  now?: () => number;
  urlDeadlineMs?: number;
  probeDeadlineMs?: number;
};

const URL_DEADLINE_MS = 30_000;
const PROBE_DEADLINE_MS = 30_000;
const PROBE_INTERVAL_MS = 1500;
/** Past the deadline the link is asked about less often, for as long as it takes. */
/** After the deadline the asks back off, doubling from here to the cap. */
const SLOW_PROBE_INTERVAL_MS = 4000;
const SLOW_PROBE_CAP_MS = 30_000;
const STOP_GRACE_MS = 3000;
const STOP_LIMIT_MS = STOP_GRACE_MS + 2000;
const PROBE_TIMEOUT_MS = 3000;

/**
 * Ask the link whether it answers, resolving its name ourselves.
 *
 * A quick tunnel's name is minutes old when this runs, and the first few
 * asks miss. The system resolver remembers a miss, so `fetch` through
 * `getaddrinfo` kept answering "no such host" long after `dig` and every
 * other machine had the address, and the probe never saw the link come up.
 * The resolver here asks the configured nameservers directly and forgets
 * nothing between asks; the request then goes to the address with the name
 * kept for TLS and the Host header. Measured on a Mac whose resolver held
 * the miss for the length of a five-minute share.
 */
async function askLink(resolver: Resolver, url: string, entryPath: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  // The direct ask first, because it forgets a miss; the system's own lookup
  // second, because a VPN or a scoped resolver may be the only thing that
  // knows the name at all.
  let address: string | undefined;
  try {
    [address] = await resolver.resolve4(target.hostname);
  } catch {
    try {
      address = (await lookup(target.hostname, { family: 4 })).address;
    } catch {
      return false;
    }
  }
  if (address === undefined) return false;
  const secure = target.protocol === "https:";
  return new Promise((resolve) => {
    const request = (secure ? https : http).request(
      {
        host: address,
        port: Number(target.port || (secure ? 443 : 80)),
        path: entryPath,
        method: "GET",
        headers: { host: target.host },
        ...(secure ? { servername: target.hostname } : {}),
        timeout: PROBE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 400);
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

/** A detached server sees the same augmented PATH its agent processes use. */
export async function detectTunnels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TunnelProviderId[]> {
  const providers = ["cloudflared", "ngrok"] as const;
  const found = await Promise.all(
    providers.map((provider) => pathLookup(provider, env).catch(() => false)),
  );
  return providers.filter((_provider, index) => found[index] === true);
}

function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function withOutput(sentence: string, output: string): string {
  if (output === "") return sentence;
  const stem = sentence.endsWith(".") ? sentence.slice(0, -1) : sentence;
  return `${stem} (${output.slice(0, 160)}).`;
}

/**
 * Start one provider and reduce everything it says to the small state the
 * interface can act on. Vendor output is evidence appended to our sentence,
 * never the sentence itself.
 */
export function startTunnel(
  options: {
    provider: TunnelProviderId;
    port: number;
    /** Path the probe requests, `/leglas/s/<token>`. */
    entryPath: string;
    onState: (state: TunnelState) => void;
  },
  deps: TunnelDeps = {},
): RunningTunnel {
  const spawn = deps.spawn ?? spawnChild;
  const now = deps.now ?? Date.now;
  const urlDeadlineMs = deps.urlDeadlineMs ?? URL_DEADLINE_MS;
  const probeDeadlineMs = deps.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  // One resolver for the tunnel's life: a channel to the configured
  // nameservers that forgets nothing between asks, made once rather than per
  // probe.
  const resolver = deps.probe === undefined ? new Resolver() : null;
  const probe =
    deps.probe ?? ((url: string) => askLink(resolver as Resolver, url, options.entryPath));

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, ms);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  let lastState = "";
  let state: TunnelState = { status: "starting", provider: options.provider };
  let terminal = false;
  let stopping = false;
  let exited = false;
  let stopPromise: Promise<void> | null = null;
  let settleStop: (() => void) | null = null;
  let url: string | null = null;
  let urlAt = 0;
  let urlTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLine = "";
  const partial = { stdout: "", stderr: "" };

  const report = (next: TunnelState): void => {
    const serialized = JSON.stringify(next);
    if (serialized === lastState) return;
    lastState = serialized;
    state = next;
    options.onState(next);
  };
  const fail = (reason: string): void => {
    if (terminal) return;
    terminal = true;
    clearTimers();
    report({
      status: "failed",
      provider: options.provider,
      reason,
      ...(url === null ? {} : { url }),
    });
  };

  report(state);

  const args =
    options.provider === "cloudflared"
      ? [
          "tunnel",
          "--url",
          `http://127.0.0.1:${options.port}`,
          "--no-autoupdate",
        ]
      : ["http", String(options.port), "--log", "stdout", "--log-format", "json"];

  let child: ReturnType<typeof spawnChild>;
  try {
    child = spawn(options.provider, args, {
      env: agentEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail(`${options.provider} exited before the tunnel came up.`);
    return { settle: () => {}, stop: async () => {} };
  }

  const beginProbe = (found: string): void => {
    if (url !== null || terminal || stopping) return;
    url = found;
    urlAt = now();
    if (urlTimer !== null) {
      clearTimeout(urlTimer);
      timers.delete(urlTimer);
      urlTimer = null;
    }
    report({ status: "starting", provider: options.provider, url });

    // The deadline changes the wording, not the verdict. The link keeps
    // being asked about, more slowly, until it answers or the process goes:
    // calling it failed here would send someone to start a fresh tunnel with
    // a fresh name and the same minute to wait.
    later(() => {
      if (terminal || stopping || url === null) return;
      report({ status: "starting", provider: options.provider, url, slow: true });
    }, probeDeadlineMs);

    let slowWait = SLOW_PROBE_INTERVAL_MS;
    const again = (): void => {
      if (terminal || stopping || url === null) return;
      if (now() - urlAt < probeDeadlineMs) {
        later(poll, PROBE_INTERVAL_MS);
        return;
      }
      later(poll, slowWait);
      slowWait = Math.min(SLOW_PROBE_CAP_MS, slowWait * 2);
    };
    const poll = (): void => {
      if (terminal || stopping || url === null) return;
      void probe(url).then(
        (reachable) => {
          if (terminal || stopping || url === null) return;
          if (reachable) {
            terminal = true;
            clearTimers();
            report({ status: "ready", provider: options.provider, url });
            return;
          }
          again();
        },
        again,
      );
    };
    poll();
  };

  const inspect = (stream: "stdout" | "stderr", line: string): void => {
    const trimmed = line.trim();
    if (trimmed !== "") lastLine = trimmed;
    if (url !== null || trimmed === "") return;

    if (options.provider === "cloudflared") {
      // Never the API host: a failed quick-tunnel request names it in the
      // error, and that is not a link to hand anyone.
      const found = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(trimmed)?.[0];
      if (found !== undefined) beginProbe(found);
      return;
    }
    if (stream !== "stdout") return;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const candidate = typeof event.url === "string" && event.url.startsWith("https://")
        ? event.url
        : null;
      if (candidate !== null) beginProbe(candidate);
    } catch {
      // ngrok's structured line may arrive in a later chunk.
    }
  };

  const read = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    const combined = partial[stream] + (Buffer.isBuffer(chunk) ? chunk.toString() : chunk);
    const lines = combined.split(/\r?\n/);
    partial[stream] = lines.pop() ?? "";
    for (const line of lines) inspect(stream, line);
    if (partial[stream] !== "") inspect(stream, partial[stream]);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => read("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => read("stderr", chunk));

  const onExit = (): void => {
    if (exited) return;
    exited = true;
    clearTimers();
    settleStop?.();
    settleStop = null;
    if (stopping) return;
    if (state.status === "ready") {
      terminal = true;
      report({
        status: "failed",
        provider: options.provider,
        url: state.url,
        reason: "The tunnel process exited.",
      });
      return;
    }
    fail(withOutput(`${options.provider} exited before the tunnel came up.`, lastLine));
  };
  child.once("error", onExit);
  child.once("exit", onExit);

  urlTimer = later(
    () =>
      fail(
        withOutput(
          `${options.provider} did not report a URL within ${duration(urlDeadlineMs)}.`,
          lastLine,
        ),
      ),
    urlDeadlineMs,
  );

  return {
    settle(): void {
      if (terminal || stopping || url === null) return;
      terminal = true;
      clearTimers();
      report({ status: "ready", provider: options.provider, url });
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopping = true;
      clearTimers();
      if (exited) return Promise.resolve();

      stopPromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          settleStop = null;
          resolve();
        };
        settleStop = done;
        try {
          child.kill("SIGTERM");
        } catch {
          done();
          return;
        }
        later(() => {
          if (exited) return done();
          try {
            child.kill("SIGKILL");
          } catch {
            // The final deadline below still releases the caller.
          }
        }, STOP_GRACE_MS);
        later(done, STOP_LIMIT_MS);
      });
      return stopPromise;
    },
  };
}
