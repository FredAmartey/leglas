import { useEffect, useState } from "react";

import { FALLBACK_MS, liveConnection } from "../net/live.js";
import { startPoll } from "../net/poll.js";
import { readShare, type SharePayload } from "./share-api.js";

/**
 * How long the read waits with nothing shared and no nudge. A share started
 * elsewhere nudges anyway; with nothing to watch, the idle tab needn't read
 * every fifteen seconds.
 */
export const IDLE_SHARE_MS = 60_000;

const NOTHING: SharePayload = { share: null, tunnels: [] };

/**
 * What's shared right now, kept current by the server's `share` nudge. One read
 * in flight, slow fallback interval, faster while a share is live, since that's
 * when state moves and someone is watching. The panel never asks for a read
 * after its own change; the server's nudge is the read.
 */
export function useShare(enabled: boolean): SharePayload {
  const [payload, setPayload] = useState<SharePayload>(NOTHING);
  const live = payload.share !== null;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const stop = startPoll(
      (signal) =>
        readShare(signal)
          .then((next) => {
            if (cancelled) return;
            setPayload((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next,
            );
          })
          .catch(() => {
            // A missed read is the fallback's problem; the last state stands.
          }),
      {
        everyMs: live ? FALLBACK_MS : IDLE_SHARE_MS,
        subscribe: (run) => liveConnection().on("share", run),
      },
    );

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, live]);

  return payload;
}
