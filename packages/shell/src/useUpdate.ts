import { useEffect, useRef, useState } from "react";

import { liveConnection } from "./live.js";
import { startPoll } from "./poll.js";
import { TOAST_TTL, type Toast } from "./toasts.js";
import type { UpdateStatus } from "./types.js";
import { checkForUpdate, installUpdate, readUpdate, skipUpdate } from "./update-api.js";
import { INSTALL_WAIT_MS, RESTART_WAIT_MS, UPDATED_KEY, type Wait } from "./update.js";

/**
 * How often the status is read when nothing nudges it. The server pushes an
 * `update` nudge on every transition it makes (a check settling, an install
 * starting, a failure), so these are fallbacks: an open panel re-reads often
 * enough that a check made from another tab shows up while someone is
 * looking, and an idle tab hardly at all, since a version changes about once
 * a day. The one state with no server to push is the wait for a restarted
 * Leglas, and that one asks every second.
 */
export const IDLE_UPDATE_MS = 15 * 60_000;
export const OPEN_UPDATE_MS = 15_000;
export const WAITING_UPDATE_MS = 1000;

export type UpdateHandle = {
  status: UpdateStatus | null;
  wait: Wait;
  /** A check this interface asked for is in flight. */
  checking: boolean;
  check(): void;
  skip(): void;
  install(): void;
};

/**
 * Whether the last status means the server is about to go away on purpose.
 *
 * An install runs while the old server still answers, and for a Leglas
 * started through a runner there is no install at all, so the interface can
 * miss the restarting phase entirely: the read fails first. Every phase
 * between pressing Update and the handover therefore counts as "expected to
 * go", and a server that answers again with the old version was a hiccup or
 * a failure, not the restart.
 */
function leaving(status: UpdateStatus | null): { version: string; allowance: number } | null {
  if (status === null) return null;
  const { phase } = status;
  if (phase.status === "installing" || phase.status === "waiting") {
    return { version: phase.version, allowance: INSTALL_WAIT_MS };
  }
  if (phase.status === "restarting") return { version: phase.version, allowance: RESTART_WAIT_MS };
  return null;
}

/** Mark the reload as an update landing, so the next interface can say so. */
function arrive(version: string): void {
  try {
    window.sessionStorage.setItem(UPDATED_KEY, version);
  } catch {
    // Nothing to carry over; the version is still visible in the chip.
  }
  window.location.reload();
}

/**
 * The running version, whether a newer one exists and where an update has
 * got to, kept current from the server, plus the interface's own wait for
 * the restarted Leglas to answer.
 */
export function useUpdate(
  enabled: boolean,
  open: boolean,
  notify: (toast: Omit<Toast, "id">) => void,
): UpdateHandle {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [wait, setWait] = useState<Wait>({ status: "none" });
  const [checking, setChecking] = useState(false);
  /**
   * What the poll's handlers read. Written after a render commits rather
   * than during it, so a render React replays or throws away cannot leak
   * into a read that is already in flight. Declared first so it is current
   * before any other effect of this hook runs.
   */
  const latest = useRef({ status, wait, notify });
  useEffect(() => {
    latest.current = { status, wait, notify };
  });

  const waiting = wait.status === "waiting";

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const stop = startPoll(
      (signal) =>
        readUpdate(signal)
          .then((next) => {
            if (cancelled) return;
            const seen = latest.current;
            if (seen.status !== null && next.version !== seen.status.version) {
              // A different Leglas answers on this origin, so the bundle that
              // is running belongs to the one that went. The version this
              // update installed means the restart landed, however late, and
              // with no update in flight any new version is a restart made by
              // hand; both reload. Anything else is a stranger on the port.
              const expected =
                seen.wait.status !== "none"
                  ? seen.wait.version
                  : (leaving(seen.status)?.version ?? null);
              if (expected === null || next.version === expected) {
                arrive(next.version);
                return;
              }
              if (seen.wait.status !== "wrong" || seen.wait.got !== next.version) {
                setWait({ status: "wrong", version: expected, got: next.version });
              }
            } else if (seen.wait.status !== "none") {
              // The old server, still here: a hiccup, or an install that failed.
              setWait({ status: "none" });
            }
            setStatus((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next,
            );
          })
          .catch(() => {
            if (cancelled || latest.current.wait.status !== "none") return;
            const going = leaving(latest.current.status);
            if (going === null) return;
            const now = Date.now();
            setWait({ status: "waiting", version: going.version, since: now, until: now + going.allowance });
            // Any other miss is the fallback's problem; the last status stands.
          }),
      {
        everyMs: waiting ? WAITING_UPDATE_MS : open ? OPEN_UPDATE_MS : IDLE_UPDATE_MS,
        subscribe: (run) => liveConnection().on("update", run),
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, open, waiting]);

  // A restart that never answers is given up on, with the way forward said
  // in the panel rather than a spinner that spins all afternoon. A late
  // answer still counts: the read above reconciles from `lost` too.
  useEffect(() => {
    if (wait.status !== "waiting") return;
    const { version, until } = wait;
    const timer = window.setTimeout(
      () => setWait((current) => (current.status === "waiting" ? { status: "lost", version } : current)),
      Math.max(0, until - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [wait]);

  // The interface after the reload: say the update landed, once.
  const ready = status !== null;
  useEffect(() => {
    if (!ready) return;
    let updated: string | null = null;
    try {
      updated = window.sessionStorage.getItem(UPDATED_KEY);
      if (updated !== null) window.sessionStorage.removeItem(UPDATED_KEY);
    } catch {
      return;
    }
    if (updated === null) return;
    latest.current.notify({
      kind: "update",
      message: `Leglas is now ${latest.current.status?.version ?? updated}`,
      tone: "success",
      ttl: TOAST_TTL.action,
    });
  }, [ready]);

  const fail = (fallback: string) => (error: unknown) =>
    latest.current.notify({
      kind: "update",
      message: error instanceof Error ? error.message : fallback,
      tone: "danger",
      ttl: TOAST_TTL.action,
    });

  const check = () => {
    if (checking) return;
    setChecking(true);
    void checkForUpdate()
      .then((next) => setStatus(next))
      .catch(fail("Leglas could not check for updates."))
      .finally(() => setChecking(false));
  };

  const skip = () => {
    const version = latest.current.status?.latest?.version;
    if (version === undefined) return;
    void skipUpdate(version)
      .then((next) => {
        setStatus(next);
        latest.current.notify({
          kind: "update",
          message: `${version} skipped`,
          note: "Nothing will nag until the next release.",
          tone: "info",
          ttl: TOAST_TTL.plain,
        });
      })
      .catch(fail("Leglas could not skip that version."));
  };

  const install = () => {
    void installUpdate()
      .then((next) => setStatus(next))
      .catch(fail("Leglas could not start the update."));
  };

  return { status, wait, checking, check, skip, install };
}
