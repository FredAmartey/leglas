import type { Server } from "node:net";

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
