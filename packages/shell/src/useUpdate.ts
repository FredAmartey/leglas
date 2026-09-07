import { useEffect, useRef, useState } from "react";

import { startPoll } from "./poll.js";
import { TOAST_TTL, type Toast } from "./toasts.js";
import type { UpdateStatus } from "./types.js";
import { checkForUpdate, installUpdate, readUpdate, skipUpdate } from "./update-api.js";
import { RESTART_WAIT_MS, UPDATED_KEY, type Wait } from "./update.js";

/**
 * How often the status is read. A version changes about once a day, so an
 * idle tab asks rarely; an open panel asks often enough that a check made
 * from the terminal or another tab shows up while someone is looking; and
 * while anything is happening (a check, an install, a restart) it asks every
 * second, because that is what the panel is showing.
 */
export const IDLE_UPDATE_MS = 15 * 60_000;
export const OPEN_UPDATE_MS = 15_000;
export const ACTIVE_UPDATE_MS = 1000;

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
 * started with npx there is no install at all, so the interface can miss the
 * restarting phase entirely: the read fails first. Both phases therefore
 * count as "expected to go", and a server that answers again while it is
 * still installing was a hiccup, not the restart.
 */
function leaving(status: UpdateStatus | null): string | null {
  if (status === null) return null;
  const { phase } = status;
  return phase.status === "installing" || phase.status === "restarting" ? phase.version : null;
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
  // Read by the poll's handlers, which are attached once per interval change
  // rather than once per render.
  const statusRef = useRef(status);
  statusRef.current = status;
  const waitRef = useRef(wait);
  waitRef.current = wait;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const active =
    wait.status === "waiting" ||
    checking ||
    (status !== null && status.phase.status !== "idle" && status.phase.status !== "failed");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const stop = startPoll(
      (signal) =>
        readUpdate(signal)
          .then((next) => {
            if (cancelled) return;
            const waiting = waitRef.current;
            if (waiting.status === "waiting") {
              if (next.version === waiting.version) {
                arrive(next.version);
                return;
              }
              if (leaving(next) !== null) {
                // The old server, still here after all.
                setWait({ status: "none" });
              } else {
                setWait({ status: "wrong", version: waiting.version, got: next.version });
                return;
              }
            }
            setStatus((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next,
            );
          })
          .catch(() => {
            if (cancelled || waitRef.current.status !== "none") return;
            const version = leaving(statusRef.current);
            if (version !== null) setWait({ status: "waiting", version, since: Date.now() });
            // Any other miss is the fallback's problem; the last status stands.
          }),
      { everyMs: active ? ACTIVE_UPDATE_MS : open ? OPEN_UPDATE_MS : IDLE_UPDATE_MS },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, open, active]);

  // A restart that never answers is given up on, with the way forward said
  // in the panel rather than a spinner that spins all afternoon.
  useEffect(() => {
    if (wait.status !== "waiting") return;
    const { version, since } = wait;
    const timer = window.setTimeout(
      () => setWait((current) => (current.status === "waiting" ? { status: "lost", version } : current)),
      Math.max(0, RESTART_WAIT_MS - (Date.now() - since)),
    );
    return () => window.clearTimeout(timer);
  }, [wait]);

  // The interface after the reload: say the update landed, once.
  useEffect(() => {
    if (status === null) return;
    let updated: string | null = null;
    try {
      updated = window.sessionStorage.getItem(UPDATED_KEY);
      if (updated !== null) window.sessionStorage.removeItem(UPDATED_KEY);
    } catch {
      return;
    }
    if (updated === null) return;
    notifyRef.current({
      kind: "update",
      message: `Leglas is now ${status.version}`,
      tone: "success",
      ttl: TOAST_TTL.action,
    });
  }, [status === null]);

  const fail = (fallback: string) => (error: unknown) =>
    notifyRef.current({
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
    const version = statusRef.current?.latest?.version;
    if (version === undefined) return;
    void skipUpdate(version)
      .then((next) => {
        setStatus(next);
        notifyRef.current({
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
