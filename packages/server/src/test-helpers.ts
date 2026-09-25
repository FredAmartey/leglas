import type { Server } from "node:net";

import { detectAgents, type DetectedAgent } from "./agents/agents.js";
import type { CdpPage } from "./capture/browser.js";
import { isString } from "./json.js";

/** Require a fixture value at the point the test expects it to exist. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a fixture value.");

  return value;
}

/** Read the TCP port only after the test's server has started listening. */
export function boundPort(server: Pick<Server, "address">): number {
  const address = server.address();

  if (address === null || isString(address)) throw new Error("Expected a listening TCP server.");

  return address.port;
}

/** A page for pool tests that never issue a CDP command. */
export const unusedPage: CdpPage = {
  send: async () => {
    throw new Error("Unexpected CDP command.");
  },
  on: () => () => {},
};

/**
 * Agent detection on a machine with no agent CLI installed, for servers under
 * test: a real startup probe runs each vendor's login status command. The
 * probe is stubbed too, so a lookup that answers yes still runs nothing.
 */
export function detectNoAgents(): Promise<DetectedAgent[]> {
  return detectAgents(
    async () => false,
    async () => null,
  );
}
