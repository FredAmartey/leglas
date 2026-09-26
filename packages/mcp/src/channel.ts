import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readRequests, type PendingRequest } from "leglas";

import type { Project } from "./project.js";

/**
 * Push for hosts that treat an MCP server as a channel: Claude Code injects the
 * events into the open session. Other hosts ignore the capability and drop the
 * events, and the queue file stays the record that the requests tool and leglas
 * watch drain.
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
 * One request as one event. The content is the composed prompt, already written
 * for an agent with no context; meta ties the event back to the queue.
 */
export function channelEvent(request: PendingRequest): ChannelEvent {
  return {
    content: request.prompt,
    meta: { direction: request.title, request_id: request.id },
  };
}

/**
 * Still queued and not yet pushed. A picked-up request is skipped so two agents
 * never get the same change. A backlog from before this process started emits
 * once, on purpose.
 */
export function unpushed(
  requests: readonly PendingRequest[],
  pushed: ReadonlySet<string>,
): PendingRequest[] {
  return requests.filter((request) => request.status === "queued" && !pushed.has(request.id));
}

export type Channel = { stop(): void };

/**
 * Start only after the server connects: a notification before the transport
 * exists throws. Emit failures are swallowed, since the queue file still holds
 * the request.
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
    // The interval doesn't wait for the last run, so without this two polls
    // read the queue before either records a push and send the same request
    // twice.
    if (busy) return;
    busy = true;

    try {
      await push();
    } finally {
      busy = false;
    }
  };

  const push = async (): Promise<void> => {
    // The first poll waits here for the host to initialize, so the queue is the
    // project's and not the start directory's.
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
        // Not connected, or the host refused. The request stays queued; only
        // the push is lost.
      }
    }
  };

  const timer = setInterval(() => void poll(), options.pollMs ?? CHANNEL_POLL_MS);
  void poll();

  return { stop: () => clearInterval(timer) };
}
