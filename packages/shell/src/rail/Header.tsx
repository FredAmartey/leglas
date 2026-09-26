import { useCallback, useRef, useState } from "react";

import type { Prefs } from "../prefs.js";
import { SharePanel } from "../share/SharePanel.js";
import { totalViewers, viewersLine } from "../share/share.js";
import { useShare } from "../share/useShare.js";
import type { Preview, UpdateStatus } from "../types.js";
import { LiveDot, Mark, P, PIcon, ShareGlyph, Tip, Wordmark } from "../ui/kit.js";
import type { Toast } from "../ui/toasts.js";
import { UpdatePanel } from "../update/UpdatePanel.js";
import { chipLabel, hasNews } from "../update/update.js";
import { useUpdate } from "../update/useUpdate.js";

/**
 * The version, quietly beside the name. It brightens with a dot when a newer
 * Leglas exists and opens the one place to install it.
 */
function VersionChip({
  buttonRef,
  news,
  onToggle,
  open,
  status,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  news: boolean;
  onToggle: () => void;
  open: boolean;
  status: UpdateStatus;
}) {
  return (
    <Tip label={chipLabel(status)}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          news
            ? `Leglas ${status.version}. ${chipLabel(status)}. Open updates`
            : `Leglas ${status.version}. Open updates`
        }
        className={`relative mt-px flex h-5 shrink-0 items-center rounded px-1 text-[10px] font-medium leading-none tabular-nums transition-colors duration-150 hover:bg-white/[0.06] ${
          news || open ? "text-[#D1D5DB] hover:text-white" : "text-[#84848C] hover:text-[#D1D5DB]"
        }`}
        onClick={onToggle}
        ref={buttonRef}
        type="button"
      >
        {status.version}
        {news && (
          <span
            aria-hidden
            className="absolute -right-px top-0 size-1.5 rounded-full bg-[#7C9CFF]"
          />
        )}
      </button>
    </Tip>
  );
}

/**
 * The top of the rail: name, version and update status, sharing, and folding
 * the rail away. Share and update each keep their own panel and reads here,
 * since nothing else asks about them.
 */
export function RailHeader({
  active,
  briefing,
  compare,
  displayName,
  notify,
  onBuild,
  onCollapse,
  prefs,
  previews,
  viewing,
}: {
  active: string;
  /** The composer is taking a brief for new directions. */
  briefing: boolean;
  /** The right-hand pane while two are on the stage, so a share can carry both. */
  compare: string | null;
  displayName: (title: string) => string;
  notify: (toast: Omit<Toast, "id">) => void;
  /** Opens the composer's brief; null while building directions is switched off. */
  onBuild: (() => void) | null;
  onCollapse: () => void;
  prefs: Prefs;
  previews: Preview[];
  /** Somebody else's rail: no sharing of it, and no version that is not theirs. */
  viewing: boolean;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const closeShare = useCallback(() => setShareOpen(false), []);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const shareState = useShare(!viewing);
  /** Which Leglas this is and whether a newer one exists; the chip by the wordmark. */
  const [updateOpen, setUpdateOpen] = useState(false);
  const closeUpdate = useCallback(() => setUpdateOpen(false), []);
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const updates = useUpdate(!viewing, updateOpen, notify);
  const news = hasNews(updates.status);

  return (
    <div className="relative z-10 flex shrink-0 items-center justify-between gap-2 border-b border-[#232328] bg-[#1E1E22] px-2.5 py-2.5">
      {/* The product names itself here, not in the list below; the search
          field and every command already say "directions". */}
      <span className="flex min-w-0 items-center gap-2">
        <Mark size={28} />
        <Wordmark height={18} />
        {/* A viewer sees the sharer's Leglas, not their own, so they get no
            version chip. */}
        {!viewing && updates.status !== null && (
          <VersionChip
            buttonRef={updateButtonRef}
            news={news}
            onToggle={() => {
              setShareOpen(false);
              setUpdateOpen((open) => !open);
            }}
            open={updateOpen}
            status={updates.status}
          />
        )}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {onBuild !== null && (
          <Tip label="Build new directions">
            <button
              aria-label="Build a set of new directions"
              aria-pressed={briefing}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-[#2E2E2E] hover:text-white ${
                briefing ? "text-white" : "text-[#9CA3AF]"
              }`}
              onClick={onBuild}
              type="button"
            >
              <PIcon d={P.plus} size={13} />
            </button>
          </Tip>
        )}
        {/* Sharing sits with the rail it shares. While live, the control
            wears the light's dot, so a possible viewer is a glance away. */}
        {!viewing && (
          <Tip
            label={
              shareState.share === null
                ? "Share this rail"
                : shareState.share.tunnel.status === "ready"
                  ? `Sharing · ${viewersLine(totalViewers(shareState.share.grants))}`
                  : "Sharing"
            }
          >
            <button
              aria-expanded={shareOpen}
              aria-haspopup="dialog"
              aria-label={shareState.share === null ? "Share" : "Sharing. Open the share panel"}
              className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-[#2E2E2E] hover:text-white ${
                shareOpen || shareState.share !== null ? "text-white" : "text-[#9CA3AF]"
              }`}
              onClick={() => {
                setUpdateOpen(false);
                setShareOpen((open) => !open);
              }}
              ref={shareButtonRef}
              type="button"
            >
              <ShareGlyph />
              {shareState.share !== null && <LiveDot className="absolute right-0 top-0" />}
            </button>
          </Tip>
        )}
        <Tip
          label={
            <>
              Collapse panel <kbd className="ml-1 text-[#9CA3AF]">[</kbd>
            </>
          }
          side="right"
        >
          <button
            aria-label="Collapse the directions panel"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#2E2E2E] hover:text-white"
            onClick={onCollapse}
            type="button"
          >
            <PIcon d={P.sidebar} size={16} />
          </button>
        </Tip>
      </span>
      {!viewing && (
        <UpdatePanel
          onClose={closeUpdate}
          open={updateOpen}
          triggerRef={updateButtonRef}
          updates={updates}
        />
      )}
      {!viewing && (
        <SharePanel
          active={active}
          compare={compare}
          displayName={displayName}
          notify={notify}
          onClose={closeShare}
          open={shareOpen}
          prefs={prefs}
          previews={previews}
          share={shareState.share}
          triggerRef={shareButtonRef}
          tunnels={shareState.tunnels}
        />
      )}
    </div>
  );
}
