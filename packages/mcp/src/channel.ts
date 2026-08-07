import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readRequests, type PendingRequest } from "leglas";

import type { Project } from "./project.js";

/**
 * The push face, for hosts that treat an MCP server as a channel.
 *
 * Claude Code's channels let a server inject events into the open session, so
 * a change request typed into the interface can reach the agent that is
 * already sitting in the project with the codebase warm. Declaring the
 * capability and emitting the events is safe everywhere: a host that does not
 * speak channels ignores the experimental capability and drops the
 * notifications without error, and the queue file stays the durable copy that
 * the requests tool and leglas watch drain. Push is a latency improvement,
 * never the record.
 */

/** Channel events queue into the session; the host reads this to know what they are. */
export const CHANNEL_INSTRUCTIONS =
  'Change requests from the Leglas interface arrive as <channel source="leglas"> events, ' +
  "each carrying an agent-ready prompt. Before acting on one, collect the queue with the " +
  "requests tool, which marks it picked up in the interface. Then make the change the " +
  "prompt describes and pass clear to the requests tool once it is done. These events are " +
  "one-way; no reply is expected.";

/** Merged into the server's capabilities; presence is what registers the listener. */
export const CHANNEL_CAPABILITY = { "claude/channel": {} };

export const CHANNEL_POLL_MS = 2000;

export type ChannelEvent = { content: string; meta: Record<string, string> };

/**
 * One request as one event. The content is the composed prompt, which is
 * already written for an agent with no other context; the meta names the
 * direction and the id so the event can be traced back to the queue.
 */
export function channelEvent(request: PendingRequest): ChannelEvent {
  return {
    content: request.prompt,
    meta: { direction: request.title, request_id: request.id },
  };
}

/**
 * The requests that deserve an event this poll: still queued, not yet pushed.
 *
 * Picked-up requests are excluded because something already has them, and a
 * re-emitted id would ask two agents to make the same change. Requests that
 * were queued before this process started do emit once, deliberately: a
 * session that opens onto a backlog should hear about it.
 */
export function unpushed(
  requests: readonly PendingRequest[],
  pushed: ReadonlySet<string>,
): PendingRequest[] {
  return requests.filter((request) => request.status === "queued" && !pushed.has(request.id));
}

export type Channel = { stop(): void };

/**
 * Poll the queue and push each new request as a channel event.
 *
 * Start this only after the server is connected: a notification before the
 * transport exists throws, and nothing here is worth crashing the host's
 * server over, so emission failures are swallowed. Delivery is fire-and-forget
 * by the channel contract anyway; an event that never lands costs nothing,
 * because the queue file still holds the request.
 */
export function startChannel(
  server: McpServer,
  options: {
    project: Project;
    pollMs?: number;
    /** Tests gate this to force overlapping polls; production reads the file. */
    read?: (cwd: string) => Promise<PendingRequest[]>;
  },
): Channel {
  const read = options.read ?? readRequests;
  const pushed = new Set<string>();
  let busy = false;

  const poll = async (): Promise<void> => {
    // The interval does not wait for the previous run. Without this guard two
    // overlapping polls read the same queue before either records a push, and
    // the same request goes out twice.
    if (busy) return;
    busy = true;
    try {
      await push();
    } finally {
      busy = false;
    }
  };

  const push = async (): Promise<void> => {
    // The first poll waits here for the host to initialize, which is what
    // makes the queue this reads the project's rather than whatever directory
    // the process happened to start in.
    const located = await options.project.locate();
    if (!located.ok) {
      // Settled for the life of the process, so there is no queue coming.
      clearInterval(timer);
      return;
    }
    const fresh = unpushed(await read(located.directory), pushed);
    for (const request of fresh) {
      pushed.add(request.id);
      try {
        await server.server.notification({
          method: "notifications/claude/channel",
          params: channelEvent(request),
        });
      } catch {
        // Not connected, or the host refused the write. The request is still
        // in the queue for the requests tool, so losing the push loses only
        // the immediacy.
      }
    }
  };

  const timer = setInterval(() => void poll(), options.pollMs ?? CHANNEL_POLL_MS);
  void poll();
  return { stop: () => clearInterval(timer) };
}
