import { useEffect, useState } from "react";

import { Tip } from "../ui/kit.js";
import { cardDetail, cardHeadline, formatElapsed, type RequestCard } from "./request-status.js";

const SPINNER =
  "size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none";

/** What kind of event the card is about, before a word of it is read. */
function Glyph({ kind }: { kind: RequestCard["kind"] }) {
  if (kind === "stopped") {
    // The same square as the button that did it: a stop is not a warning,
    // and the amber triangle said otherwise.
    return (
      <span
        aria-hidden="true"
        className="flex size-3.5 shrink-0 items-center justify-center text-[#84848C]"
      >
        <span className="block size-2 rounded-[2px] bg-current" />
      </span>
    );
  }

  if (kind === "failed") {
    return (
      <svg
        aria-hidden="true"
        className="shrink-0 text-amber-400/90"
        fill="none"
        height="14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        viewBox="0 0 16 16"
        width="14"
      >
        <path d="M8 2.6 14.6 13.4H1.4Z" />
        <path d="M8 6.8v2.7" />
        <path d="M8 11.6h.01" />
      </svg>
    );
  }

  if (kind === "queued") {
    return (
      <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
        <span className="size-1.5 animate-pulse rounded-full bg-[#84848C] motion-reduce:animate-none" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-white/15 border-t-white/70 motion-reduce:animate-none"
    />
  );
}

/** One of the card's small buttons: its icon, or a spinner while the server answers. */
function CardButton({
  busy,
  children,
  disabled,
  label,
  onClick,
  standalone = false,
  tip,
}: {
  busy: boolean;
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  /** Set for a button that sits in the card's own row rather than in a group. */
  standalone?: boolean;
  tip: string;
}) {
  return (
    <Tip label={tip}>
      <button
        aria-label={label}
        className={`flex h-6 w-6 ${standalone ? "shrink-0 " : ""}items-center justify-center rounded-md text-[#84848C] transition-[background-color,color,transform] duration-150 hover:bg-white/[0.06] hover:text-white active:scale-[0.96] disabled:cursor-wait disabled:opacity-40 motion-reduce:transition-none`}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {busy ? <span className={SPINNER} /> : children}
      </button>
    </Tip>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="13"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 16 16"
      width="13"
    >
      {children}
    </svg>
  );
}

/**
 * One card, one event: the run in flight, the queue waiting, or the failure
 * asking what to do about it. It lives above the composer the way a reply
 * lives above the thing being typed, and it never takes the chooser or the
 * field hostage.
 */
export function StatusCard({
  action,
  card,
  onCancel,
  onDismiss,
  onRetry,
}: {
  /** Which of the card's buttons is waiting on the server, if any. */
  action: "cancel" | "retry" | "dismiss" | null;
  card: RequestCard;
  onCancel: (id: string | null) => void;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  // The elapsed counter ticks locally between polls; the anchor comes from
  // the server so a reload half-way through a run does not restart it. The
  // tick lives here so that one second passing redraws this card and not the
  // rail and the stage around it. The quiet line reads the same clock.
  const runStartedAt = card.kind === "running" ? card.startedAt : null;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (runStartedAt === null) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [runStartedAt]);
  const detail = cardDetail(card, runStartedAt === null ? null : clock);

  return (
    <div
      className="mx-3 mt-2 rounded-lg border border-[#232328] bg-[#1E1E22] px-2.5 py-2 shadow-lg"
      role="status"
    >
      <div className="flex items-center gap-2">
        <Glyph kind={card.kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium leading-tight text-[#D1D5DB]">
            {cardHeadline(card)}
          </p>
          {detail !== null && (
            /* Not truncated to one line: a failure's reason is the whole
               point of showing it, and "Claude is not signed in" cut at the
               rail's width says nothing. */
            <p className="mt-0.5 text-[10px] leading-tight text-[#84848C]">{detail}</p>
          )}
        </div>
        {runStartedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-[#84848C]">
            {formatElapsed(clock - runStartedAt)}
          </span>
        )}
        {card.kind === "running" && (
          <CardButton
            busy={action === "cancel" || card.stopping}
            disabled={action !== null || card.stopping}
            label="Stop this run"
            onClick={() => onCancel(card.id)}
            standalone
            tip="Stop this run"
          >
            <span className="block size-2 rounded-[2px] bg-current" />
          </CardButton>
        )}
        {(card.kind === "failed" || card.kind === "stopped") && (
          <span className="flex shrink-0 items-center">
            <CardButton
              busy={action === "retry"}
              disabled={action !== null}
              label={card.kind === "stopped" ? "Run this change after all" : "Retry this change"}
              onClick={() => onRetry(card.id)}
              tip={card.kind === "stopped" ? "Run it after all" : "Try it again"}
            >
              <Icon>
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                <path d="M13.7 1.8v2.7H11" />
              </Icon>
            </CardButton>
            <CardButton
              busy={action === "dismiss"}
              disabled={action !== null}
              label={
                card.kind === "stopped"
                  ? "Dismiss this stopped change"
                  : "Dismiss this failed change"
              }
              onClick={() => onDismiss(card.id)}
              tip="Let it go"
            >
              <Icon>
                <path d="m4 4 8 8M12 4l-8 8" />
              </Icon>
            </CardButton>
          </span>
        )}
      </div>
    </div>
  );
}
