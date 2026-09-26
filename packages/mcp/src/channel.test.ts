import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PendingRequest } from "leglas";
import { afterEach, describe, expect, test } from "vitest";

import {
  CHANNEL_CAPABILITY,
  channelEvent,
  startChannel,
  unpushed,
  type Channel,
  type ChannelEvent,
} from "./channel.js";
import { fixedProject } from "./project.js";

const channels: Channel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) channel.stop();
});

const request = (id: string, status: PendingRequest["status"]): PendingRequest => ({
  id,
  status,
  title: "Aurora",
  url: "/?v-hero=aurora",
  intent: "warmer",
  target: ".leglas/variants/hero/aurora.tsx",
  prompt: `Change only Aurora (${id}).`,
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-channel-"));
}

function writeQueue(cwd: string, requests: PendingRequest[]): void {
  mkdirSync(join(cwd, ".leglas"), { recursive: true });
  writeFileSync(join(cwd, ".leglas/requests.json"), JSON.stringify({ requests }));
}

function isChannelEvent(value: unknown): value is ChannelEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string" &&
    "meta" in value &&
    typeof value.meta === "object" &&
    value.meta !== null &&
    Object.values(value.meta).every((entry): entry is string => typeof entry === "string")
  );
}

/** A connected pair with the client capturing channel notifications. */
async function connect(
  cwd: string,
  pollMs: number,
  read?: (cwd: string) => Promise<PendingRequest[]>,
): Promise<{ events: ChannelEvent[] }> {
  const server = new McpServer(
    { name: "leglas-test", version: "0.0.0" },
    { capabilities: { experimental: CHANNEL_CAPABILITY } },
  );

  const client = new Client({ name: "test-host", version: "0.0.0" });
  const events: ChannelEvent[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "notifications/claude/channel") return;
    const event = notification.params;

    if (!isChannelEvent(event)) throw new Error("Malformed channel event.");
    events.push(event);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const options: Parameters<typeof startChannel>[1] = { project: fixedProject(cwd), pollMs };

  if (read !== undefined) options.read = read;
  channels.push(startChannel(server, options));

  return { events };
}

/** How long a wait may take before it is a hang rather than a slow machine. */
const EVENTUALLY_MS = 15_000;

/**
 * Bounds a hang, not latency. Watch events and reachability probes arrive when
 * the OS gets to them, and a suite that fails a slow machine teaches people to
 * rerun until it passes.
 */
const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + EVENTUALLY_MS;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((tick) => setTimeout(tick, 10));
  }
};

describe("channelEvent", () => {
  test("meta keys are identifier-safe, which the channel contract requires", () => {
    // The host silently drops keys with hyphens, so a renamed key would vanish
    // without an error.
    const keys = Object.keys(channelEvent(request("x", "queued")).meta);

    // So the loop below can't pass on an empty list.
    expect(keys).toEqual(expect.arrayContaining(["direction", "request_id"]));

    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe("unpushed", () => {
  test("offers queued requests once and never picked-up ones", () => {
    const queue = [request("a", "queued"), request("b", "picked-up"), request("c", "queued")];

    expect(unpushed(queue, new Set(["a"])).map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("startChannel", () => {
  test("pushes a queued request to the connected host once", async () => {
    const cwd = scratch();
    writeQueue(cwd, [request("first", "queued")]);
    const { events } = await connect(cwd, 20);

    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({
      content: "Change only Aurora (first).",
      meta: { direction: "Aurora", request_id: "first" },
    });

    // Later polls see the same queue and push nothing new.
    await new Promise((tick) => setTimeout(tick, 80));
    expect(events).toHaveLength(1);
  });

  test("overlapping polls never double-emit a request", async () => {
    // The gated read lets several ticks pile up on one backlog. Without the
    // guard a second poll emits from the live queue while the first walks its
    // stale copy, and a request goes out twice.
    const cwd = scratch();
    const backlog = [request("a", "queued"), request("b", "queued")];
    writeQueue(cwd, backlog);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const read = async () => {
      await gate;

      return backlog;
    };

    const { events } = await connect(cwd, 10, read);
    await new Promise((tick) => setTimeout(tick, 60));
    release?.();

    await until(() => events.length >= 2);
    await new Promise((tick) => setTimeout(tick, 60));
    const ids = events.map((event) => event.meta.request_id);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  test("stays quiet when there is no project to poll", async () => {
    // Nothing to read and nothing coming, so the queue is never touched.
    let reads = 0;

    const server = new McpServer(
      { name: "leglas-test", version: "0.0.0" },
      { capabilities: { experimental: CHANNEL_CAPABILITY } },
    );

    const client = new Client({ name: "test-host", version: "0.0.0" });
    const events: unknown[] = [];
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === "notifications/claude/channel") events.push(notification.params);
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    channels.push(
      startChannel(server, {
        project: { locate: async () => ({ ok: false, reason: "no project" }) },
        pollMs: 10,
        read: async () => {
          reads += 1;

          return [];
        },
      }),
    );

    await new Promise((tick) => setTimeout(tick, 80));

    expect(reads).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("a request queued later arrives as its own event", async () => {
    const cwd = scratch();
    writeQueue(cwd, [request("first", "queued")]);
    const { events } = await connect(cwd, 20);
    await until(() => events.length === 1);

    writeQueue(cwd, [request("first", "queued"), request("second", "queued")]);

    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ meta: { request_id: "second" } });
  });
});
