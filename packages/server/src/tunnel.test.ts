import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { detectTunnels, startTunnel, type TunnelState } from "./tunnel.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (this.closeOnSignal) queueMicrotask(() => this.emit("exit", null, signal ?? null));
    return true;
  });

  constructor(private readonly closeOnSignal = true) {
    super();
  }
}

function spawnHarness(closeOnSignal = true) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild(closeOnSignal);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { children, spawn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startTunnel", () => {
  test("reads a cloudflared URL from stderr and becomes ready after the probe", async () => {
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const probe = vi.fn(async () => true);
    const tunnel = startTunnel(
      {
        provider: "cloudflared",
        port: 4321,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe },
    );

    spawned.children[0]?.stderr.write(
      "| https://example-share.trycloudflare.com |\n",
    );
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    expect(states).toEqual([
      { status: "starting", provider: "cloudflared" },
      {
        status: "starting",
        provider: "cloudflared",
        url: "https://example-share.trycloudflare.com",
      },
      {
        status: "ready",
        provider: "cloudflared",
        url: "https://example-share.trycloudflare.com",
      },
    ]);
    expect(probe).toHaveBeenCalledWith("https://example-share.trycloudflare.com");
    expect(spawned.spawn).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:4321", "--no-autoupdate"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({ PATH: expect.any(String) }),
      }),
    );
    await tunnel.stop();
  });

  test("reads ngrok's JSON line and accepts its https fallback", async () => {
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const tunnel = startTunnel(
      {
        provider: "ngrok",
        port: 4322,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe: async () => true },
    );

    spawned.children[0]?.stdout.write(
      `${JSON.stringify({ msg: "started tunnel", url: "https://share.example.test" })}\n`,
    );
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    expect(states).toContainEqual({
      status: "starting",
      provider: "ngrok",
      url: "https://share.example.test",
    });
    expect(states.at(-1)).toEqual({
      status: "ready",
      provider: "ngrok",
      url: "https://share.example.test",
    });
    expect(spawned.spawn).toHaveBeenCalledWith(
      "ngrok",
      ["http", "4322", "--log", "stdout", "--log-format", "json"],
      expect.any(Object),
    );
    await tunnel.stop();
  });

  test("fails when no URL arrives before the deadline", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const tunnel = startTunnel(
      {
        provider: "cloudflared",
        port: 4323,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe: async () => false, urlDeadlineMs: 10 },
    );
    spawned.children[0]?.stderr.write("waiting for an edge\n");

    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toEqual({
      status: "failed",
      provider: "cloudflared",
      reason: "cloudflared did not report a URL within 10ms (waiting for an edge).",
    });
    await tunnel.stop();
  });

  test("fails when the process exits before reporting a URL", async () => {
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const tunnel = startTunnel(
      {
        provider: "ngrok",
        port: 4324,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe: async () => false },
    );
    spawned.children[0]?.stdout.write("authentication failed\n");
    spawned.children[0]?.emit("exit", 1, null);

    expect(states.at(-1)).toEqual({
      status: "failed",
      provider: "ngrok",
      reason: "ngrok exited before the tunnel came up (authentication failed).",
    });
    await tunnel.stop();
  });

  test("says the link is slow past the probe deadline and keeps asking until it answers", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    let answering = false;
    const probe = vi.fn(async () => answering);
    const tunnel = startTunnel(
      {
        provider: "cloudflared",
        port: 4325,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe, probeDeadlineMs: 10 },
    );
    spawned.children[0]?.stderr.write("https://example-share.trycloudflare.com\n");

    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toEqual({
      status: "starting",
      provider: "cloudflared",
      url: "https://example-share.trycloudflare.com",
      slow: true,
    });

    // Still asking, at the slower pace, and the answer arriving late is
    // still the answer.
    const asked = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(probe.mock.calls.length).toBeGreaterThan(asked);
    answering = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(states.at(-1)).toEqual({
      status: "ready",
      provider: "cloudflared",
      url: "https://example-share.trycloudflare.com",
    });
    await tunnel.stop();
  });

  test("settle reports the link ready on outside evidence and stops asking", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const probe = vi.fn(async () => false);
    const tunnel = startTunnel(
      {
        provider: "cloudflared",
        port: 4327,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe },
    );
    // Nothing to settle before a URL exists.
    tunnel.settle();
    expect(states.at(-1)?.status).toBe("starting");
    spawned.children[0]?.stderr.write("https://example-share.trycloudflare.com\n");
    await vi.advanceTimersByTimeAsync(0);
    tunnel.settle();
    expect(states.at(-1)).toEqual({
      status: "ready",
      provider: "cloudflared",
      url: "https://example-share.trycloudflare.com",
    });
    const asked = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe.mock.calls.length).toBe(asked);
    await tunnel.stop();
  });

  test("never takes cloudflared's API host for the link", async () => {
    const spawned = spawnHarness();
    const states: TunnelState[] = [];
    const tunnel = startTunnel(
      {
        provider: "cloudflared",
        port: 4328,
        entryPath: "/leglas/s/token",
        onState: (state) => states.push(state),
      },
      { spawn: spawned.spawn, probe: async () => true },
    );
    spawned.children[0]?.stderr.write(
      'ERR Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup failed\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(states.at(-1)).toEqual({ status: "starting", provider: "cloudflared" });
    await tunnel.stop();
  });

  test("stop sends SIGTERM, escalates and resolves on its own deadline", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness(false);
    const tunnel = startTunnel(
      {
        provider: "ngrok",
        port: 4326,
        entryPath: "/leglas/s/token",
        onState: () => {},
      },
      { spawn: spawned.spawn, probe: async () => false },
    );

    const stopped = tunnel.stop();
    expect(spawned.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(3000);
    expect(spawned.children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(stopped).resolves.toBeUndefined();
  });
});

describe("detectTunnels", () => {
  test("finds an executable on the augmented PATH and omits a missing provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leglas-"));
    const binary = join(directory, "cloudflared");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const platform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

    try {
      const providers = await detectTunnels({ PATH: directory, HOME: "" });

      expect(providers).toContain("cloudflared");
      expect(providers).not.toContain("ngrok");
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
    }
  });
});
