import { useEffect, useReducer, useRef, useState } from "react";

import { Mark } from "./kit.js";
import { FALLBACK_MS, liveConnection } from "./live.js";
import { startPoll, wasAborted } from "./poll.js";
import { Shell } from "./Shell.js";
import type { ConfigPayload } from "./types.js";

type Load =
  | { status: "loading" }
  | { status: "ready"; config: ConfigPayload }
  | { status: "failed"; message: string }
  /**
   * A shared interface whose server stopped answering. The person sharing
   * stops, or their Leglas goes, and the link goes with it; the rail that
   * was on screen is kept behind this so a return brings it straight back.
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

export function App() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** A viewer asking again, after the share went quiet. */
  const [retries, retry] = useReducer((count: number) => count + 1, 0);
  /**
   * Reads that failed in a row. A tunnel edge answers one bad page while it
   * reconnects, and a viewer's own network blinks; neither is the share
   * ending, so the rail stays until a second read agrees.
   */
  const misses = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const read = (signal: AbortSignal) =>
      fetch("/leglas/api/config", { signal }).then((response) => {
        if (!response.ok) {
          throw Object.assign(new Error(`the server answered ${response.status}`), {
            status: response.status,
          });
        }
        return response.json() as Promise<ConfigPayload>;
      });

    // An agent registers directions while this is open, so new previews have
    // to appear as they are added. The server says when: it watches the
    // config and the previews file and nudges, and this reads on the nudge.
    // The interval underneath is the fallback for a socket that died
    // quietly, which is why it is slow rather than the pace.
    //
    // Updates only apply on a changed payload, so the steady state
    // re-renders nothing, and a failure once the rail is up changes nothing:
    // transient server hiccups are the health banner's story, not a reason
    // to blank it. A failure before that is the difference between a started
    // interface and none, so it shows.
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
          .catch((error: unknown) => {
            if (cancelled) return;
            if (!wasAborted(error)) misses.current += 1;
            // The share listener refusing the cookie is the sharer having
            // stopped: final, and a new link is the only way back. Anything
            // else is the tunnel or the network, and two misses in a row is
            // what it takes to call it.
            const refused = (error as { status?: unknown }).status === 403;
            setLoad((current) =>
              (current.status === "ready" || current.status === "ended") &&
              current.config.viewer !== undefined
                ? wasAborted(error) || (!refused && misses.current < 2)
                  ? current
                  : { status: "ended", config: current.config, final: refused }
                : current.status === "ready"
                  ? current
                  : {
                    status: "failed",
                    // An abandoned read is the poll's own deadline, not
                    // anything the server said, and its wording is internal.
                    message: wasAborted(error)
                      ? "it did not answer in time"
                      : error instanceof Error
                        ? error.message
                        : String(error),
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
        The person sharing it stopped. A share they start later comes with a new link, so ask
        them for that one.
      </Notice>
    ) : (
      <Notice title="This share isn’t answering">
        The link is not reaching their Leglas right now: their machine may be asleep, or the
        tunnel between you is resetting. It comes back on its own when it can.
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

  // A config that failed validation is reported here rather than swallowed:
  // the server stays up precisely so this screen can say what to fix.
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
