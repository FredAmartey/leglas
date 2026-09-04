import { useEffect, useState } from "react";

import { FALLBACK_MS, liveConnection } from "./live.js";
import { startPoll } from "./poll.js";
import { readShare, type SharePayload } from "./share-api.js";

/**
 * How long the read waits with nothing shared and nothing nudging it. A
 * share that starts elsewhere (another tab) nudges anyway; this is only the
 * backstop, and with nothing to watch it need not cost the idle tab a read
 * every fifteen seconds.
 */
export const IDLE_SHARE_MS = 60_000;

const NOTHING: SharePayload = { share: null, tunnels: [] };

/**
 * What is shared right now, kept current by the server's `share` nudge.
 *
 * The loop follows the same two rules as every other read in the shell: one
 * in flight at a time, a slow interval as the fallback. It ticks faster while
 * a share is live, because that is when the state moves (the tunnel coming
 * up, a viewer arriving) and when someone is looking at it. The panel never
 * asks for a read after a change it made: the server nudges `share` on
 * every one, and that is the read.
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
