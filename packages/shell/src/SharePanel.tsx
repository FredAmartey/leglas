import { useEffect, useRef, useState } from "react";

import { copyText } from "./clipboard.js";
import { Tip } from "./kit.js";
import type { Prefs } from "./prefs.js";
import {
  railShare,
  sameShare,
  scopeLine,
  shortLink,
  stageShare,
  viewersLine,
  type ShareRequest,
} from "./share.js";
import { startShare, stopShare, updateShare } from "./share-api.js";
import { TOAST_TTL } from "./toasts.js";
import type { Preview, ShareStatus, TunnelProviderId } from "./types.js";
import type { ShellState } from "./useShellState.js";

const PROVIDER_NAMES: Record<TunnelProviderId, string> = {
  cloudflared: "cloudflared",
  ngrok: "ngrok",
};

/** How long the tick stays on the copy button before it turns back into one. */
const COPIED_MS = 1400;

/** A shared line's own colour, the light's Ember, so "live" reads as the rail does. */
export function LiveDot({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`leglas-live-dot block size-1.5 rounded-full ${className}`} />;
}

/** The mark on the share control: an arrow leaving a tray. */
export function ShareGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
      width={size}
    >
      <path d="M8 9.75V2.75" />
      <path d="m5.25 5.5 2.75-2.75 2.75 2.75" />
      <path d="M3.25 8.75v3.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5v-3.5" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="block size-3 animate-spin rounded-full border-[1.5px] border-white/15 border-t-white/70 motion-reduce:animate-none"
    />
  );
}

function Warning() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-amber-400/90"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="12"
    >
      <path d="M8 2.6 14.6 13.4H1.4Z" />
      <path d="M8 6.8v2.7" />
      <path d="M8 11.6h.01" />
    </svg>
  );
}

/**
 * One of the two things a share can be, drawn as a radio row: what it is on
 * the first line, what that comes to on the second.
 */
function ScopeRow({
  checked,
  detail,
  disabled = false,
  onPick,
  title,
}: {
  checked: boolean;
  detail: string;
  disabled?: boolean;
  onPick: () => void;
  title: string;
}) {
  return (
    <button
      aria-checked={checked}
      className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : checked
            ? "bg-[#2E2E2E]/70"
            : "hover:bg-white/[0.04]"
      }`}
      disabled={disabled}
      onClick={onPick}
      role="radio"
      type="button"
    >
      <span
        aria-hidden
        className={`mt-[3px] flex size-3 shrink-0 items-center justify-center rounded-full border transition-colors ${
          checked ? "border-[#E8E8EA]" : "border-[#84848C]"
        }`}
      >
        <span
          className={`size-1.5 rounded-full bg-[#E8E8EA] transition-transform duration-150 motion-reduce:transition-none ${
            checked ? "scale-100" : "scale-0"
          }`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-xs ${checked ? "text-white" : "text-[#D1D5DB]"}`}>{title}</span>
        <span className="mt-0.5 block truncate text-[10px] leading-snug text-[#84848C]">{detail}</span>
      </span>
    </button>
  );
}

/**
 * Sharing, as the popover under the rail's share control.
 *
 * Two screens. Before a share: what to send (the rail as you see it, or what
 * is on stage) and how it will get out (the tunnel program found on this
 * machine), then one button. During a share: the link, whether it is
 * answering yet, who is looking, and the two things left to do, push what
 * you see now to them or stop. Nothing a viewer does comes back through
 * here; a share is a window, not a door.
 */
export function SharePanel({
  active,
  compare,
  displayName,
  notify,
  onClose,
  open,
  prefs,
  previews,
  refresh,
  share,
  triggerRef,
  tunnels,
}: {
  active: string;
  /** The right pane while the stage is split, else null. */
  compare: string | null;
  displayName: (title: string) => string;
  notify: ShellState["notify"];
  onClose: () => void;
  open: boolean;
  prefs: Prefs;
  previews: readonly Preview[];
  /** Ask the status read to go again, after a change made here. */
  refresh: () => void;
  share: ShareStatus | null;
  /** The control that opened this, for focus to return to. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  tunnels: readonly TunnelProviderId[];
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<"rail" | "stage">("rail");
  const [busy, setBusy] = useState<"start" | "stop" | "update" | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The share this panel started, if any. The link is put on the clipboard
   * the moment it answers, once, and only for a share started from here: a
   * share begun in another tab would otherwise copy over whatever this one's
   * clipboard was holding.
   */
  const startedHere = useRef<string | null>(null);
  const autoCopied = useRef<string | null>(null);

  const rail = railShare(prefs, previews);
  const stage = stageShare(prefs, previews, active, compare);
  const picked = choice === "rail" ? rail.request : stage.request;
  const provider: TunnelProviderId | "none" = tunnels[0] ?? "none";

  /**
   * What an update would send: the same kind of share the live one is, made
   * from the rail as it is now. Offered only when it differs, so the button
   * is a fact about the rail rather than a habit.
   */
  const next: ShareRequest | null =
    share === null ? null : share.scope === "rail" ? rail.request : stage.request;
  const changed =
    share !== null &&
    next !== null &&
    !sameShare(next, { scope: share.scope, titles: share.titles, layout: share.layout });

  const link = share === null ? null : (share.url ?? share.localUrl);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };
    const onWindowBlur = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open, onClose, triggerRef]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLink = (url: string, quiet = false) =>
    copyText(url).then((outcome) => {
      if (outcome === "blocked") {
        setCopied(false);
        notify({
          detail: url,
          kind: "share",
          message: "Your browser blocked the clipboard. The link is:",
          tone: "danger",
          ttl: null,
        });
        return;
      }
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      if (!quiet) {
        notify({ kind: "share", message: "Share link copied", tone: "success", ttl: TOAST_TTL.plain });
      }
    });

  // The link goes to the clipboard on its own the moment there is one,
  // because the next thing the person does with it is paste it somewhere,
  // and a name that has not spread yet will have by the time it is clicked.
  // Then one more word when it answers, so they know it did.
  const tunnelUrl = share === null || !("url" in share.tunnel) ? null : (share.tunnel.url ?? null);
  const tunnelStatus = share?.tunnel.status ?? null;
  useEffect(() => {
    if (share === null || tunnelUrl === null || startedHere.current !== share.id) return;
    if (autoCopied.current !== share.id) {
      autoCopied.current = share.id;
      void copyLink(share.url ?? tunnelUrl, true).then(() =>
        notify({
          kind: "share",
          message:
            tunnelStatus === "ready"
              ? "Your share is live. Link copied."
              : "Share link copied. Waiting for it to answer…",
          tone: "success",
          ttl: TOAST_TTL.action,
        }),
      );
      return;
    }
    if (tunnelStatus === "ready") {
      notify({ kind: "share", message: "Your share is live.", tone: "success", ttl: TOAST_TTL.plain });
    }
    // notify and copyLink are stable enough for this; the share is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.id, tunnelUrl, tunnelStatus]);

  const fail = (error: unknown, fallback: string) =>
    notify({
      kind: "share",
      message: error instanceof Error ? error.message : fallback,
      tone: "danger",
      ttl: TOAST_TTL.action,
    });

  const start = (request: ShareRequest) => {
    if (busy !== null) return;
    setBusy("start");
    void startShare({ ...request, tunnel: provider })
      .then((started) => {
        startedHere.current = started.id;
        refresh();
      })
      .catch((error: unknown) => fail(error, "Leglas could not start sharing."))
      .finally(() => setBusy(null));
  };

  const stop = () => {
    if (busy !== null) return;
    setBusy("stop");
    void stopShare()
      .then(() => {
        refresh();
        notify({ kind: "share", message: "Stopped sharing", tone: "info", ttl: TOAST_TTL.plain });
      })
      .catch((error: unknown) => fail(error, "Leglas could not stop sharing."))
      .finally(() => setBusy(null));
  };

  const update = () => {
    if (busy !== null || next === null) return;
    setBusy("update");
    void updateShare(next)
      .then(() => {
        refresh();
        notify({
          kind: "share",
          message: "Viewers now see the rail as you do",
          tone: "success",
          ttl: TOAST_TTL.plain,
        });
      })
      .catch((error: unknown) => fail(error, "Leglas could not update the share."))
      .finally(() => setBusy(null));
  };

  /** A failed tunnel is tried again with what was shared, not with the rail now. */
  const retry = () => {
    if (busy !== null || share === null) return;
    const request: ShareRequest = { scope: share.scope, titles: share.titles, layout: share.layout };
    setBusy("start");
    void stopShare()
      .then(() => startShare({ ...request, tunnel: provider }))
      .then((started) => {
        startedHere.current = started.id;
        refresh();
      })
      .catch((error: unknown) => fail(error, "Leglas could not start sharing."))
      .finally(() => setBusy(null));
  };

  return (
    <div
      aria-hidden={!open}
      aria-label="Share"
      className={`absolute inset-x-3 top-full z-30 mt-1.5 origin-top-right rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 text-[#D1D5DB] shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
        open ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none -translate-y-1 scale-95 opacity-0"
      }`}
      inert={!open}
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      {share === null ? (
        <>
          <span className="block px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
            Share
          </span>
          <div aria-label="What to share" className="flex flex-col gap-0.5" role="radiogroup">
            <ScopeRow
              checked={choice === "rail"}
              detail={
                rail.request.titles.length === 0
                  ? "Nothing on the rail can be shared yet"
                  : `${rail.request.titles.length} direction${
                      rail.request.titles.length === 1 ? "" : "s"
                    }${
                      rail.leftOut.length === 0
                        ? ", as you see them"
                        : ` · ${rail.leftOut.length} on ${
                            rail.leftOut.length === 1 ? "a branch" : "branches"
                          } left out`
                    }`
              }
              disabled={rail.request.titles.length === 0}
              onPick={() => setChoice("rail")}
              title="The whole rail"
            />
            <ScopeRow
              checked={choice === "stage"}
              detail={
                stage.request === null
                  ? (stage.reason ?? "")
                  : scopeLine(stage.request.scope, stage.request.titles, displayName)
              }
              disabled={stage.request === null}
              onPick={() => setChoice("stage")}
              title={compare !== null && compare !== active ? "The comparison on stage" : "The direction on stage"}
            />
          </div>

          <div className="mt-1.5 border-t border-[#232328] px-1 pb-1 pt-2">
            {provider === "none" ? (
              <>
                <p className="flex items-center gap-1.5 text-[11px] text-amber-300/90">
                  <Warning />
                  No tunnel program found
                </p>
                <p className="mt-1 text-[10px] leading-snug text-[#84848C]">
                  Install <span className="text-[#9CA3AF]">cloudflared</span> or{" "}
                  <span className="text-[#9CA3AF]">ngrok</span> and Leglas will use it. Without one
                  the link only works on this machine.
                </p>
              </>
            ) : (
              <p className="text-[10px] leading-snug text-[#84848C]">
                Out through <span className="text-[#9CA3AF]">{PROVIDER_NAMES[provider]}</span> on this
                machine. The link lives as long as Leglas does.
              </p>
            )}
          </div>

          <button
            className="mt-1 flex h-7 w-full items-center justify-center rounded-md bg-[#E8E8EA] text-xs font-medium text-[#1C1C20] transition-[background-color,transform] duration-150 hover:bg-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            disabled={busy !== null || picked === null || picked.titles.length === 0}
            onClick={() => {
              if (picked !== null) start(picked);
            }}
            type="button"
          >
            {busy === "start" ? (
              <Spinner />
            ) : provider === "none" ? (
              "Start on this machine"
            ) : (
              "Start sharing"
            )}
          </button>
          <p className="px-1 pb-0.5 pt-2 text-[10px] leading-snug text-[#84848C]">
            They see the real app, and can flip, compare and change the width. Nothing they do
            reaches your machine.
          </p>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1.5 px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
            {share.tunnel.status === "ready" ? <LiveDot /> : null}
            Sharing
          </span>

          <div className="flex items-center gap-1 rounded-md border border-[#232328] bg-[#2E2E2E]/40 py-1 pl-2 pr-1">
            <span
              className="min-w-0 flex-1 select-text truncate font-mono text-[11px] text-[#E8E8EA]"
              data-selectable
              title={link ?? undefined}
            >
              {link === null ? "" : shortLink(link)}
            </span>
            <Tip label={copied ? "Copied" : "Copy the link"}>
              <button
                aria-label="Copy the share link"
                className="flex h-6 shrink-0 items-center justify-center rounded px-1.5 text-[10px] font-medium text-[#D1D5DB] transition-colors hover:bg-white/[0.06] hover:text-white"
                onClick={() => {
                  if (link !== null) void copyLink(link);
                }}
                type="button"
              >
                {copied ? <span className="text-emerald-300">✓</span> : "Copy"}
              </button>
            </Tip>
          </div>

          <div aria-live="polite" className="px-1 pt-2 text-[11px] leading-snug">
            {share.tunnel.status === "ready" ? (
              <p className="flex items-center gap-1.5 text-[#D1D5DB]">
                <LiveDot />
                Live · {viewersLine(share.viewers)}
              </p>
            ) : share.tunnel.status === "starting" ? (
              <div className="flex items-start gap-1.5 text-[#9CA3AF]">
                <span className="mt-[3px]">
                  <Spinner />
                </span>
                {share.tunnel.url === undefined ? (
                  <span>Opening a tunnel through {PROVIDER_NAMES[share.tunnel.provider]}…</span>
                ) : share.tunnel.slow ? (
                  /* Not a failure, and not called one: a new tunnel name
                     takes a while to spread, and this machine's resolver
                     may be the last to hear. The link is already theirs to
                     send. */
                  <span>
                    Still waiting for the link to answer from here. New tunnel names take a
                    minute to spread, so it may already work for whoever you send it to.
                  </span>
                ) : (
                  <span>Waiting for the link to answer…</span>
                )}
              </div>
            ) : share.tunnel.status === "failed" ? (
              <div>
                <p className="flex items-start gap-1.5 text-amber-300/90">
                  <span className="mt-0.5">
                    <Warning />
                  </span>
                  <span>{share.tunnel.reason}</span>
                </p>
                <button
                  className="mt-1 rounded text-[10px] text-[#9CA3AF] underline underline-offset-2 transition-colors hover:text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={retry}
                  type="button"
                >
                  Try again
                </button>
              </div>
            ) : (
              <p className="text-[#9CA3AF]">
                Reachable from this machine only. Point a tunnel of your own at{" "}
                <span className="select-text font-mono text-[#D1D5DB]" data-selectable>
                  127.0.0.1:{share.sharePort}
                </span>{" "}
                and send that host with the same path.
              </p>
            )}
          </div>

          <p className="truncate px-1 pt-1.5 text-[10px] text-[#84848C]">
            {scopeLine(share.scope, share.titles, displayName)}
          </p>

          <div className="mt-2 flex items-center gap-1 border-t border-[#232328] pt-1.5">
            {changed ? (
              <button
                className="flex h-7 min-w-0 flex-1 items-center justify-center rounded-md bg-[#2E2E2E] px-2 text-xs font-medium text-white transition-[background-color,transform] duration-150 hover:bg-[#3A3A40] active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none"
                disabled={busy !== null}
                onClick={update}
                type="button"
              >
                {busy === "update" ? <Spinner /> : "Update what they see"}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate px-2 text-[10px] text-[#84848C]">
                {share.scope === "rail" ? "They see the rail as you do" : "They see what you shared"}
              </span>
            )}
            <button
              className="flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-xs text-[#9CA3AF] transition-[color,background-color,transform] duration-150 hover:bg-white/[0.06] hover:text-red-300 active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none"
              disabled={busy !== null}
              onClick={stop}
              type="button"
            >
              {busy === "stop" ? <Spinner /> : "Stop"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
