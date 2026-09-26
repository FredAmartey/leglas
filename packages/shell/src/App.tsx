import { useEffect, useReducer, useRef, useState } from "react";

import { Mark } from "./ui/kit.js";
import { FALLBACK_MS, liveConnection } from "./net/live.js";
import { startPoll, wasAborted } from "./net/poll.js";
import { Shell } from "./Shell.js";
import type { ConfigPayload } from "./types.js";
import { readJson } from "./net/api.js";

type Load =
  | { status: "loading" }
  | { status: "ready"; config: ConfigPayload }
  | { status: "failed"; message: string }
  /**
   * A shared interface whose server stopped answering: the sharer stopped or
   * their Leglas went. The last rail stays behind this so a return brings it
   * straight back.
   */
  | { status: "ended"; config: ConfigPayload; final: boolean };

/** A quiet full-screen message, used for both startup and config problems. */
function Notice({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div
      className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#1C1C20] px-6 text-center antialiased"
      style={{ fontFamily: "var(--font-satoshi)" }}
    >
      <Mark size={22} />
      <p className="text-sm font-medium text-white">{title}</p>
      <div className="max-w-md text-xs leading-relaxed text-[#84848C]">{children}</div>
    </div>
  );
}

/** The server answered, and said no. */
class Refused extends Error {
  constructor(readonly status: number) {
    super(`the server answered ${status}`);
  }
}

export function App() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** A viewer asking again, after the share went quiet. */
  const [retries, retry] = useReducer((count: number) => count + 1, 0);
  /**
   * Failed reads in a row. A tunnel edge serves one bad page while reconnecting
   * and a viewer's network blinks, so the rail stays until a second read
   * agrees.
   */
  const misses = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const read = (signal: AbortSignal) =>
      fetch("/leglas/api/config", { signal }).then((response) => {
        if (!response.ok) {
          throw new Refused(response.status);
        }

        return readJson<ConfigPayload>(response);
      });

    // New previews must appear as an agent registers them. The server watches
    // the config and previews file and nudges; this reads on the nudge, with a
    // slow fallback interval for a quietly dead socket.
    //
    // Only a changed payload updates state, so the steady state renders
    // nothing. A failure after the rail is up changes nothing (the health
    // banner covers hiccups); one before it shows.
    const stop = startPoll(
      (signal) =>
        read(signal)
          .then((config) => {
            if (cancelled) return;
            misses.current = 0;
            setLoad((current) =>
              current.status === "ready" &&
              JSON.stringify(current.config) === JSON.stringify(config)
                ? current
                : { status: "ready", config },
            );
          })
          .catch((cause: unknown) => {
            if (cancelled) return;

            if (!wasAborted(cause)) misses.current += 1;
            // The share listener refusing the cookie means the sharer stopped:
            // final, only a new link helps. Anything else is the tunnel or the
            // network, and takes two misses in a row.
            const refused = cause instanceof Refused && cause.status === 403;
            setLoad((current) =>
              (current.status === "ready" || current.status === "ended") &&
              current.config.viewer !== undefined
                ? wasAborted(cause) || (!refused && misses.current < 2)
                  ? current
                  : { status: "ended", config: current.config, final: refused }
                : current.status === "ready"
                  ? current
                  : {
                      status: "failed",
                      // An abandoned read is the poll's own deadline, and its
                      // wording is internal.
                      message: wasAborted(cause)
                        ? "it did not answer in time"
                        : cause instanceof Error
                          ? cause.message
                          : String(cause),
                    },
            );
          }),
      {
        everyMs: FALLBACK_MS,
        subscribe: (run) => liveConnection().on("config", run),
      },
    );

    return () => {
      cancelled = true;
      stop();
    };
  }, [retries]);

  if (load.status === "loading") return <Notice title="Starting Leglas…">{null}</Notice>;

  if (load.status === "ended") {
    return load.final ? (
      <Notice title="This share has ended">
        The person sharing it stopped. A share they start later comes with a new link, so ask them
        for that one.
      </Notice>
    ) : (
      <Notice title="This share isn’t answering">
        The link is not reaching their Leglas right now: their machine may be asleep, or the tunnel
        between you is resetting. It comes back on its own when it can.
        <p className="mt-4">
          <button
            className="rounded-md bg-[#2E2E2E] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#3A3A40]"
            onClick={retry}
            type="button"
          >
            Try again
          </button>
        </p>
      </Notice>
    );
  }

  if (load.status === "failed") {
    return (
      <Notice title="Couldn’t reach the Leglas server">
        {load.message}. The interface is served by the same process that proxies your app, so this
        usually means it stopped.
      </Notice>
    );
  }

  // A config that failed validation is shown here; the server stays up so this
  // screen can say what to fix.
  if (load.config.errors.length > 0) {
    return (
      <Notice title="Your config needs fixing">
        <ul className="space-y-1 text-left">
          {load.config.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
        <p className="mt-3">Fix it and restart Leglas.</p>
      </Notice>
    );
  }

  return (
    <Shell
      previews={load.config.previews}
      project={load.config.project}
      scanPreviews={load.config.scanPreviews ?? true}
      viewer={load.config.viewer}
      warnings={load.config.warnings ?? []}
    />
  );
}
