import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { copyText } from "./clipboard.js";
import { ICON_BUTTON, LiveDot, P, PIcon, Spinner, Tip, Warning } from "./kit.js";
import type { Prefs } from "./prefs.js";
import {
  expiryLine,
  grantLabel,
  railShare,
  sameShare,
  scopeLine,
  shortLink,
  stageShare,
  viewersLine,
  type ShareRequest,
} from "./share.js";
import {
  createGrant,
  extendGrant,
  revokeGrant,
  rotateShare,
  startShare,
  stopShare,
  updateShare,
} from "./share-api.js";
import { TOAST_TTL } from "./toasts.js";
import type { Preview, ShareGrant, ShareStatus, TunnelProviderId } from "./types.js";
import type { ShellState } from "./useShellState.js";

const PROVIDER_NAMES: Record<TunnelProviderId, string> = {
  cloudflared: "cloudflared",
  ngrok: "ngrok",
};

/** How long the tick stays on the copy button before it turns back into one. */
const COPIED_MS = 1400;

const PRIMARY_BUTTON =
  "flex h-7 w-full items-center justify-center rounded-md bg-[#E8E8EA] text-xs font-medium text-[#1C1C20] transition-[background-color,transform] duration-150 hover:bg-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

type Busy = "start" | "stop" | "update" | "grant" | "revoke" | "extend" | "rotate" | null;

/** A plus, for giving a link another day. */
function PlusGlyph() {
  return (
    <svg
      aria-hidden
      fill="none"
      height="11"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
      viewBox="0 0 16 16"
      width="11"
    >
      <path d="M8 3.5v9M3.5 8h9" />
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

/** Before a share: what to send, how it gets out, one button. */
function ShareSetup({
  busy,
  choice,
  displayName,
  onPick,
  onStart,
  provider,
  rail,
  stage,
  stageOfPair,
}: {
  busy: Busy;
  choice: "rail" | "stage";
  displayName: (title: string) => string;
  onPick: (choice: "rail" | "stage") => void;
  onStart: () => void;
  provider: TunnelProviderId | "none";
  rail: ReturnType<typeof railShare>;
  stage: ReturnType<typeof stageShare>;
  stageOfPair: boolean;
}) {
  const picked = choice === "rail" ? rail.request : stage.request;
  const railCount = rail.request.titles.length;
  return (
    <>
      <span className="block px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
        Share
      </span>
      <div aria-label="What to share" className="flex flex-col gap-0.5" role="radiogroup">
        <ScopeRow
          checked={choice === "rail"}
          detail={
            railCount === 0
              ? "Nothing on the rail can be shared yet"
              : `${railCount} direction${railCount === 1 ? "" : "s"}${
                  rail.leftOut.length === 0
                    ? ", as you see them"
                    : ` · ${rail.leftOut.length} on ${
                        rail.leftOut.length === 1 ? "a branch" : "branches"
                      } left out`
                }`
          }
          disabled={railCount === 0}
          onPick={() => onPick("rail")}
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
          onPick={() => onPick("stage")}
          title={stageOfPair ? "The comparison on stage" : "The direction on stage"}
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
              <span className="text-[#9CA3AF]">ngrok</span> and Leglas will use it. Without one the
              link only works on this machine.
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
        className={`mt-1 ${PRIMARY_BUTTON}`}
        disabled={busy !== null || picked === null || picked.titles.length === 0}
        onClick={onStart}
        type="button"
      >
        {busy === "start" ? <Spinner /> : provider === "none" ? "Start on this machine" : "Start sharing"}
      </button>
      <p className="px-1 pb-0.5 pt-2 text-[10px] leading-snug text-[#84848C]">
        They see the real app and can flip, compare and change the width. They cannot change
        anything, and they read whatever your dev server serves.
      </p>
    </>
  );
}

/** During a share: the link, whether it answers, who is looking, update or stop. */
/**
 * One link, as a row: what it is called and who is on it, then the address
 * with what can be done to it.
 *
 * The actions sit under the pointer rather than in the row's width, because
 * a share can hold sixteen of these and a panel is 368px wide. The rail's
 * rows do the same, so the gesture is one the user already has.
 */
function GrantRow({
  busy,
  copied,
  grant,
  index,
  now,
  onCopy,
  onExtend,
  onRevoke,
  only,
}: {
  busy: Busy;
  copied: boolean;
  grant: ShareGrant;
  index: number;
  now: number;
  onCopy: () => void;
  onExtend: () => void;
  onRevoke: () => void;
  /** The last link: revoking it leaves the share with no way in. */
  only: boolean;
}) {
  const left = expiryLine(grant.expiresAt, now);
  const ending = grant.expiresAt - now < 60 * 60 * 1000;
  const label = grantLabel(grant.name, index);
  return (
    <li className="group relative flex h-8 items-center gap-2 rounded-md px-2 transition-colors hover:bg-white/[0.04]">
      <span className="min-w-0 flex-1 truncate text-xs text-[#D1D5DB]">{label}</span>
      {/* The state gives way to the actions, so a row stays one line and
          nothing shares its width with buttons that are only wanted under
          the pointer. Every link on a share carries the same host, so the
          address is said once above the list rather than sixteen times. */}
      <span
        className={`shrink-0 text-[10px] group-hover:hidden group-has-[button:focus-visible]:hidden ${
          ending ? "text-amber-300/80" : grant.viewers > 0 ? "text-[#D1D5DB]" : "text-[#84848C]"
        }`}
      >
        {grant.viewers > 0 ? `${viewersLine(grant.viewers)} · ${left}` : left}
      </span>
      {/* Faded rather than `hidden`: display:none takes a button out of the
          accessibility tree and out of the tab order, so the row's actions
          would be unreachable by keyboard and invisible to a screen reader.
          The rail's rows fade for the same reason. */}
      <span className="pointer-events-none absolute right-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[button:focus-visible]:pointer-events-auto group-has-[button:focus-visible]:opacity-100 motion-reduce:transition-none">
        <Tip label={copied ? "Copied" : "Copy this link"}>
          <button
            aria-label={`Copy the ${label} link`}
            className={ICON_BUTTON}
            onClick={onCopy}
            type="button"
          >
            {copied ? <span className="text-[10px] text-emerald-300">✓</span> : <PIcon d={P.link} />}
          </button>
        </Tip>
        <Tip label="Another 24 hours">
          <button
            aria-label={`Extend the ${label} link`}
            className={ICON_BUTTON}
            disabled={busy !== null}
            onClick={onExtend}
            type="button"
          >
            <PlusGlyph />
          </button>
        </Tip>
        {/* Short, because the list scrolls and a tip inside a scroller is
            clipped by it. What matters beyond the verb is that this is the
            last way in, which the label says in three words. */}
        <Tip label={only ? "Turn off · the last link" : "Turn off"}>
          <button
            aria-label={`Turn the ${label} link off`}
            className={`${ICON_BUTTON} hover:text-red-300`}
            disabled={busy !== null}
            onClick={onRevoke}
            type="button"
          >
            <PIcon d={P.trash} size={12} />
          </button>
        </Tip>
      </span>
    </li>
  );
}

/** The row that makes another link, with the name typed before it exists. */
function NewLink({ busy, onCreate }: { busy: Busy; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        className="mt-0.5 w-full rounded-md px-2 py-1.5 text-left text-[11px] text-[#84848C] transition-colors hover:bg-white/[0.04] hover:text-[#D1D5DB] disabled:opacity-50"
        disabled={busy !== null}
        onClick={() => setOpen(true)}
        type="button"
      >
        + Another link
      </button>
    );
  }
  return (
    <form
      className="mt-0.5 flex items-center gap-1 px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(name.trim());
        setName("");
        setOpen(false);
      }}
    >
      <input
        aria-label="Who this link is for"
        autoFocus
        className="min-w-0 flex-1 rounded border border-[#232328] bg-[#2E2E2E]/40 px-1.5 py-1 text-[11px] text-white placeholder:text-[#84848C] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/40"
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setName("");
          setOpen(false);
        }}
        placeholder="Who is it for?"
        value={name}
      />
      <button
        className="shrink-0 rounded px-2 py-1 text-[11px] font-medium text-[#D1D5DB] transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
        disabled={busy !== null}
        type="submit"
      >
        {busy === "grant" ? <Spinner /> : "Make"}
      </button>
    </form>
  );
}

function ShareLive({
  busy,
  changed,
  copiedId,
  displayName,
  now,
  onCopy,
  onCreate,
  onExtend,
  onRetry,
  onRevoke,
  onRotate,
  onStop,
  onUpdate,
  share,
}: {
  busy: Busy;
  changed: boolean;
  copiedId: string | null;
  displayName: (title: string) => string;
  now: number;
  onCopy: (grant: ShareGrant) => void;
  onCreate: (name: string) => void;
  onExtend: (grant: ShareGrant) => void;
  onRetry: () => void;
  onRevoke: (grant: ShareGrant) => void;
  onRotate: () => void;
  onStop: () => void;
  onUpdate: () => void;
  share: ShareStatus;
}) {
  const tunnel = share.tunnel;
  return (
    <>
      <span className="flex items-center gap-1.5 px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
        {tunnel.status === "ready" ? <LiveDot /> : null}
        Sharing
      </span>

      <div aria-live="polite" className="px-1 pb-1.5 text-[11px] leading-snug">
        {tunnel.status === "ready" ? (
          <p className="flex items-center gap-1.5">
            <LiveDot />
            <span className="min-w-0 flex-1 truncate select-text font-mono text-[10px] text-[#D1D5DB]" data-selectable>
              {new URL(share.grants[0]?.url ?? "http://x").host}
            </span>
          </p>
        ) : tunnel.status === "starting" ? (
          <div className="flex items-start gap-1.5 text-[#9CA3AF]">
            <span className="mt-[3px]">
              <Spinner />
            </span>
            {tunnel.url === undefined ? (
              <span>Opening a tunnel through {PROVIDER_NAMES[tunnel.provider]}…</span>
            ) : tunnel.slow ? (
              /* Not a failure, and not called one: a new tunnel name takes a
                 while to spread, and this machine's resolver may be the last
                 to hear. The link is already theirs to send. */
              <span>
                Still waiting for the link to answer from here. New tunnel names take a minute to
                spread, so it may already work for whoever you send it to.
              </span>
            ) : (
              <span>Waiting for the link to answer…</span>
            )}
          </div>
        ) : tunnel.status === "failed" ? (
          <div>
            <p className="flex items-start gap-1.5 text-amber-300/90">
              <span className="mt-0.5">
                <Warning />
              </span>
              <span>{tunnel.reason}</span>
            </p>
            <button
              className="mt-1 rounded text-[10px] text-[#9CA3AF] underline underline-offset-2 transition-colors hover:text-white disabled:opacity-50"
              disabled={busy !== null}
              onClick={onRetry}
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

      <ul aria-label="Links into this share" className="max-h-64 overflow-y-auto">
        {share.grants.map((grant, index) => (
          <GrantRow
            busy={busy}
            copied={copiedId === grant.id}
            grant={grant}
            index={index}
            key={grant.id}
            now={now}
            onCopy={() => onCopy(grant)}
            onExtend={() => onExtend(grant)}
            onRevoke={() => onRevoke(grant)}
            only={share.grants.length === 1}
          />
        ))}
        {share.grants.length === 0 ? (
          <li className="px-2 py-1.5 text-[11px] text-[#84848C]">
            No links. Nobody can open this share until you make one.
          </li>
        ) : null}
      </ul>
      <NewLink busy={busy} onCreate={onCreate} />

      <p className="truncate px-1 pt-1.5 text-[10px] text-[#84848C]">
        {scopeLine(share.scope, share.titles, displayName)}
      </p>

      <div className="mt-2 flex items-center gap-1 border-t border-[#232328] pt-1.5">
        {changed ? (
          <button
            className="flex h-7 min-w-0 flex-1 items-center justify-center rounded-md bg-[#2E2E2E] px-2 text-xs font-medium text-white transition-[background-color,transform] duration-150 hover:bg-[#3A3A40] active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none"
            disabled={busy !== null}
            onClick={onUpdate}
            type="button"
          >
            {busy === "update" ? <Spinner /> : "Update what they see"}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate px-2 text-[10px] text-[#84848C]">
            {share.scope === "rail" ? "They see the rail as you do" : "They see what you shared"}
          </span>
        )}
        {/* For a leak with no known source: every link ends and the address
            changes with them, so no copy of any of them reaches anything. */}
        <Tip
          label={
            <>
              <span className="block">Replace every link.</span>
              <span className="block text-[#9CA3AF]">
                For when one got somewhere you did not mean to send it.
              </span>
            </>
          }
          wide
        >
          <button
            aria-label="Replace every link and the address with them"
            className="flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-xs text-[#9CA3AF] transition-[color,background-color,transform] duration-150 hover:bg-white/[0.06] hover:text-white active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none"
            disabled={busy !== null}
            onClick={onRotate}
            type="button"
          >
            {busy === "rotate" ? <Spinner /> : "Replace all"}
          </button>
        </Tip>
        <button
          className="flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-xs text-[#9CA3AF] transition-[color,background-color,transform] duration-150 hover:bg-white/[0.06] hover:text-red-300 active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none"
          disabled={busy !== null}
          onClick={onStop}
          type="button"
        >
          {busy === "stop" ? <Spinner /> : "Stop"}
        </button>
      </div>
    </>
  );
}

/**
 * Sharing, as the popover under the rail's share control.
 *
 * Two screens. Before a share: what to send (the rail as you see it, or what
 * is on stage) and how it will get out (the tunnel program found on this
 * machine), then one button. During a share: the link, whether it is
 * answering yet, who is looking and the two things left to do, push what
 * you see now to them or stop. Nothing a viewer does comes back through
 * here: the panel is the sharer's, and a viewer never reaches it.
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
  share: ShareStatus | null;
  /** The control that opened this, for focus to return to. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  tunnels: readonly TunnelProviderId[];
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<"rail" | "stage">("rail");
  const [busy, setBusy] = useState<Busy>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /**
   * A clock the panel reads, so "23h left" becomes "40m left" while the
   * panel is open rather than at the next poll. A minute is fine: nothing
   * here is measured in seconds, and a faster tick would re-render a list
   * for no visible change.
   */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The share this panel started, if any. The link is put on the clipboard
   * the moment there is one, once, and only for a share started from here: a
   * share begun in another tab would otherwise copy over whatever this one's
   * clipboard was holding.
   */
  const startedHere = useRef<string | null>(null);
  const autoCopied = useRef<string | null>(null);
  // Read through a ref by the listeners, so the dismissal wiring is attached
  // once per opening rather than once per render of the shell.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Worked out only when the inputs move: the shell re-renders on every
  // hover and poll, and this panel is mounted whether or not it is open.
  const rail = useMemo(() => railShare(prefs, previews), [prefs, previews]);
  const stage = useMemo(
    () => stageShare(prefs, previews, active, compare),
    [prefs, previews, active, compare],
  );
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

  /**
   * The link worth handing anyone: the public one once the tunnel has a
   * name, or the local one when there is no tunnel at all. Nothing while a
   * tunnel is still opening, because a local link copied then only works on
   * this machine and the person it was sent to has no way to know.
   */
  const first = share?.grants[0] ?? null;
  const link =
    first === null
      ? null
      : first.url !== null
        ? first.url
        : share?.tunnel.status === "none"
          ? first.localUrl
          : null;

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const trigger = triggerRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        trigger?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !trigger?.contains(target)) onCloseRef.current();
    };
    const onWindowBlur = () => onCloseRef.current();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open, triggerRef]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLink = (url: string, quiet = false, forId: string | null = null) =>
    copyText(url).then((outcome) => {
      if (outcome === "blocked") {
        setCopiedId(null);
        // A copy nobody asked for that the browser refused (the tab was not
        // in front, or the browser wants a gesture) is not worth a warning;
        // the button is right there. A click that failed is.
        if (quiet) return;
        notify({
          detail: url,
          kind: "share",
          message: "Your browser blocked the clipboard. The link is:",
          tone: "danger",
          ttl: null,
        });
        return;
      }
      setCopiedId(forId);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_MS);
      if (!quiet) {
        notify({ kind: "share", message: "Share link copied", tone: "success", ttl: TOAST_TTL.plain });
      }
    });

  // The link goes to the clipboard on its own the moment there is one,
  // because the next thing the person does with it is paste it somewhere,
  // and a name that has not spread yet will have by the time it is clicked.
  // Then one more word when it answers, so they know it did.
  const tunnelStatus = share?.tunnel.status ?? null;
  useEffect(() => {
    if (share === null || link === null || startedHere.current !== share.id) return;
    if (autoCopied.current !== share.id) {
      autoCopied.current = share.id;
      void copyLink(link, true).then(() =>
        notify({
          kind: "share",
          message:
            tunnelStatus === "ready" || tunnelStatus === "none"
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
  }, [share?.id, link, tunnelStatus]);

  const fail = (error: unknown, fallback: string) =>
    notify({
      kind: "share",
      message: error instanceof Error ? error.message : fallback,
      tone: "danger",
      ttl: TOAST_TTL.action,
    });

  // The server nudges `share` after every change, and that nudge is the
  // read; nothing here asks for one.
  const start = (request: ShareRequest) => {
    if (busy !== null) return;
    setBusy("start");
    void startShare({ ...request, tunnel: provider })
      .then((started) => {
        startedHere.current = started.id;
      })
      .catch((error: unknown) => fail(error, "Leglas could not start sharing."))
      .finally(() => setBusy(null));
  };

  const stop = () => {
    if (busy !== null) return;
    setBusy("stop");
    void stopShare()
      .then(() => {
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
  /**
   * One shape for the four link writes: mark what is busy, take the share
   * the server answers with, and say what happened. The server nudges as
   * well, so the panel is right either way; this only makes it immediate.
   */
  const grantWrite = (
    kind: Exclude<Busy, null>,
    run: () => Promise<ShareStatus>,
    said: string,
  ) => {
    if (busy !== null) return;
    setBusy(kind);
    void run()
      .then(() => {
        notify({ kind: "share", message: said, tone: "success", ttl: TOAST_TTL.plain });
      })
      .catch((error: unknown) => fail(error, "That did not work."))
      .finally(() => setBusy(null));
  };

  const retry = () => {
    if (busy !== null || share === null) return;
    const request: ShareRequest = { scope: share.scope, titles: share.titles, layout: share.layout };
    setBusy("start");
    void stopShare()
      .then(() => startShare({ ...request, tunnel: provider }))
      .then((started) => {
        startedHere.current = started.id;
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
        <ShareSetup
          busy={busy}
          choice={choice}
          displayName={displayName}
          onPick={setChoice}
          onStart={() => {
            const picked = choice === "rail" ? rail.request : stage.request;
            if (picked !== null) start(picked);
          }}
          provider={provider}
          rail={rail}
          stage={stage}
          stageOfPair={compare !== null && compare !== active}
        />
      ) : (
        <ShareLive
          busy={busy}
          changed={changed}
          copiedId={copiedId}
          displayName={displayName}
          now={clock}
          onCopy={(grant) => {
            const address = grant.url ?? grant.localUrl;
            void copyLink(address, false, grant.id);
          }}
          onCreate={(name) =>
            grantWrite("grant", () => createGrant(name), name === "" ? "Link made" : `Link for ${name}`)
          }
          onExtend={(grant) =>
            grantWrite("extend", () => extendGrant(grant.id), "Another 24 hours on that link")
          }
          onRetry={retry}
          onRevoke={(grant) =>
            grantWrite("revoke", () => revokeGrant(grant.id), "That link is off")
          }
          onRotate={() =>
            grantWrite("rotate", () => rotateShare(), "Every link replaced, and the address with them")
          }
          onStop={stop}
          onUpdate={update}
          share={share}
        />
      )}
    </div>
  );
}
