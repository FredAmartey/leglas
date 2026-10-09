import type { Server } from "node:net";

import { detectAgents, type DetectedAgent } from "./agents/agents.js";
import type { CdpPage } from "./capture/browser.js";
import { isString } from "./json.js";

/** Require a fixture value at the point the test expects it to exist. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a fixture value.");

  return value;
}

/** A response's JSON, typed as the shape the test asserts on. */
export async function readJson<T>(response: Response): Promise<T> {
  // SAFETY: tests read their own server's routes and assert on every field they use.
  return (await response.json()) as T;
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
 * Agent detection on a machine with no agent CLIs, for servers under test. The
 * probe is stubbed too, so nothing runs even if a lookup says yes.
 */
export function detectNoAgents(): Promise<DetectedAgent[]> {
  return detectAgents(
    async () => false,
    async () => null,
  );
}
