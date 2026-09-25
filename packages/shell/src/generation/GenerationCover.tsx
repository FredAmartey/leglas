import { useEffect, useState } from "react";

import { formatElapsed } from "../agents/request-status.js";
import type { GenerationSlot } from "./generation.js";

const DARK =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-[background-color,transform] duration-150 hover:bg-neutral-700 active:scale-[0.96] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none";

const LIGHT =
  "rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-800 transition-[background-color,transform] duration-150 hover:bg-neutral-200 active:scale-[0.96] disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none";

/**
 * How far the build has got: what it is doing, from its own stream, and how
 * long it has been at it against how long these usually take. The clock
 * ticks here, so a second passing redraws this line and nothing else.
 */
function Progress({ slot }: { slot: GenerationSlot }) {
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, []);

  // While checking, a step can only be a fix run's; otherwise the page is being opened.
  const doing = slot.activity ?? (slot.state === "checking" ? "opening the page" : "starting");

  return (
    <p className="mt-3 text-[11px] leading-snug text-neutral-400">
      <span className="block truncate">{doing}</span>
      <span className="tabular-nums">
        {slot.startedAt === null ? "" : `${formatElapsed(clock - slot.startedAt)} · `}
        usually a minute or two
      </span>
    </p>
  );
}

/**
 * What the stage shows for a direction that is not ready: its placeholder
 * renders nothing, and a blank page would read as broken. It stands in for
 * the app, so it is white like the other stage overlays, and it says what
 * the direction is meant to be while Claude works on it.
 */
export function GenerationCover({
  acting,
  name,
  onReplace,
  onRetry,
  onStop,
  slot,
}: {
  /** A button's request is on its way to the server. */
  acting: boolean;
  name: string;
  onReplace: () => void;
  onRetry: () => void;
  onStop: () => void;
  slot: GenerationSlot;
}) {
  if (slot.state === "building" || slot.state === "checking") {
    return (
      <div
        aria-live="polite"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center"
      >
        <span className="size-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 motion-reduce:animate-none" />
        <div className="max-w-xs">
          <p className="text-sm font-medium text-neutral-800">
            {slot.state === "building" ? `Claude is building ${name}` : `Checking ${name} renders`}
          </p>
          <p className="mt-1 text-xs leading-snug text-neutral-500">{slot.idea}</p>
          <Progress slot={slot} />
        </div>
        <button className={LIGHT} disabled={acting} onClick={onStop} type="button">
          Stop
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center"
      role="alert"
    >
      <div className="max-w-xs">
        <p className="text-sm font-medium text-neutral-800">
          {slot.state === "failed" ? `${name} didn’t build` : `${name} was stopped`}
        </p>
        <p className="mt-1 text-xs leading-snug text-neutral-500">
          {slot.state === "failed" ? (slot.failure?.message ?? "It did not build.") : slot.idea}
        </p>
      </div>
      <div className="flex gap-2">
        <button className={DARK} disabled={acting} onClick={onRetry} type="button">
          {slot.state === "failed" ? "Try again" : "Build it"}
        </button>
        <button className={LIGHT} disabled={acting} onClick={onReplace} type="button">
          Try a new idea
        </button>
      </div>
    </div>
  );
}
