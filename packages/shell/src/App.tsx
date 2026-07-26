import { useEffect, useState } from "react";

import { Mark } from "./kit.js";
import { Shell } from "./Shell.js";
import type { ConfigPayload } from "./types.js";

type Load =
  | { status: "loading" }
  | { status: "ready"; config: ConfigPayload }
  | { status: "failed"; message: string };

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

  useEffect(() => {
    let cancelled = false;
    void fetch("/leglas/api/config")
      .then((response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return response.json() as Promise<ConfigPayload>;
      })
      .then((config) => {
        if (!cancelled) setLoad({ status: "ready", config });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.status === "loading") return <Notice title="Starting Leglas…">{null}</Notice>;

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

  return <Shell previews={load.config.previews} project={load.config.project} />;
}
