import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PendingRequest } from "leglas";
import { afterEach, describe, expect, test } from "vitest";

import { CHANNEL_CAPABILITY, channelEvent, startChannel, unpushed, type Channel } from "./channel.js";
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

/** A connected pair with the client capturing channel notifications. */
async function connect(
  cwd: string,
  pollMs: number,
  read?: (cwd: string) => Promise<PendingRequest[]>,
): Promise<{ events: unknown[] }> {
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
  channels.push(startChannel(server, { project: fixedProject(cwd), pollMs, read }));
  return { events };
}

const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((tick) => setTimeout(tick, 10));
  }
};

describe("channelEvent", () => {
  test("carries the prompt as the body and identifies the request", () => {
    const event = channelEvent(request("abc123", "queued"));

    expect(event.content).toBe("Change only Aurora (abc123).");
    expect(event.meta).toEqual({ direction: "Aurora", request_id: "abc123" });
  });

  test("meta keys are identifier-safe, which the channel contract requires", () => {
    // Keys with hyphens are silently dropped by the host, so a rename here
    // would lose the attribute without any error saying so.
    for (const key of Object.keys(channelEvent(request("x", "queued")).meta)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    }
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
    // The read is gated so several interval ticks pile up on it, then all
    // resolve with the same two-request backlog. An unguarded loop lets a
    // second poll emit from the live queue while the first is still walking
    // its stale snapshot, and the second request goes out twice.
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
    const ids = events.map((event) => (event as { meta: { request_id: string } }).meta.request_id);
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
