import { useEffect, useRef, useState } from "react";

import { liveConnection } from "../net/live.js";
import { startPoll } from "../net/poll.js";
import { TOAST_TTL, type Toast } from "../ui/toasts.js";
import type { UpdateStatus } from "../types.js";
import { checkForUpdate, installUpdate, readUpdate, skipUpdate } from "./update-api.js";
import { INSTALL_WAIT_MS, RESTART_WAIT_MS, UPDATED_KEY, type Wait } from "./update.js";

/**
 * How often status is read with no nudge. The server nudges on every
 * transition, so these are fallbacks: an open panel re-reads often enough to
 * catch a check from another tab, an idle tab hardly at all. Waiting for a
 * restarted Leglas, with no server to push, asks every second.
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
 * Whether the last status means the server is about to leave on purpose. An
 * install runs while the old server answers, and a runner-started Leglas has no
 * install, so the read can fail before any restarting phase shows. Every phase
 * from pressing Update counts as expected to go; the old version answering
 * again was a hiccup or a failure.
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
   * What the poll's handlers read, written after a render commits so a replayed
   * or discarded render can't leak into a read in flight. Declared first so
   * it's current before this hook's other effects.
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
              // A different Leglas answers here, so this bundle belongs to the
              // one that left. The installed version means the restart landed,
              // however late; with no update in flight, any new version is a
              // manual restart. Both reload. Anything else is a stranger on the
              // port.
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
              // The old server is still here: a hiccup, or a failed install.
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
            setWait({
              status: "waiting",
              version: going.version,
              since: now,
              until: now + going.allowance,
            });
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

  // A restart that never answers is given up on with the next step shown, not a
  // spinner all afternoon. A late answer still counts; the read above
  // reconciles from `lost` too.
  useEffect(() => {
    if (wait.status !== "waiting") return;
    const { version, until } = wait;

    const timer = window.setTimeout(
      () =>
        setWait((current) =>
          current.status === "waiting" ? { status: "lost", version } : current,
        ),
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

  const fail = (fallback: string) => (cause: unknown) =>
    latest.current.notify({
      kind: "update",
      message: cause instanceof Error ? cause.message : fallback,
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
