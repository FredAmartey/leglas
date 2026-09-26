import { EASE } from "../prefs.js";
import { refusalWords, type FrameRefusal } from "../preview/framing.js";
import { previewFrameIsReady } from "../preview/preview-frame.js";
import type { BranchPreviewState } from "../types.js";
import { BranchOverlay, ErrorOverlay, RefusedOverlay, SkeletonOverlay } from "../ui/kit.js";

const CHIP =
  "rounded-full bg-[#1C1C20]/85 px-2.5 py-1 text-[11px] font-medium text-[#E8E8EA] shadow-lg backdrop-blur";

/**
 * What's said over a pane's frame: why it failed, why the page refused it, or
 * the skeleton until it draws.
 */
function PaneOverlay({
  errored,
  fromApp,
  loaded,
  onReload,
  onShowAnyway,
  refusal,
  serverUp,
  src,
}: {
  errored: boolean;
  fromApp: boolean;
  loaded: boolean;
  onReload: () => void;
  onShowAnyway: () => void;
  refusal: FrameRefusal | null;
  serverUp: boolean;
  src: string;
}) {
  if (errored) {
    return (
      <ErrorOverlay
        onReload={onReload}
        reason={
          serverUp || !fromApp
            ? `${src} didn’t respond.`
            : "Your dev server stopped. This returns on its own once it is back."
        }
      />
    );
  }

  if (refusal !== null) {
    return (
      <RefusedOverlay
        href={src}
        onShowAnyway={onShowAnyway}
        {...refusalWords(refusal, src, window.location.origin)}
      />
    );
  }

  return <SkeletonOverlay loaded={loaded} />;
}

/**
 * One direction on the stage: its frame and whatever needs saying over it. Off
 * stage it stays mounted and hidden, so coming back doesn't reload it.
 */
export function Pane({
  annotate,
  cover = null,
  onOpen = null,
  boxHeight,
  boxWidth,
  branch,
  branchName,
  busy,
  designWidth,
  errored,
  frameHeight,
  framed,
  fromApp,
  identity,
  loaded,
  name,
  onError,
  onReady,
  onReload,
  onShowAnyway,
  onStartBranch,
  order,
  paneScale,
  refusal,
  scaling,
  second,
  serverUp,
  shown,
  splitting,
  src,
  title,
  viewport,
}: {
  /** The layer notes are left on, while this pane is the one being annotated. */
  annotate: React.ReactNode;
  /** Said over the whole frame instead of the page, such as a direction still being built. */
  cover?: React.ReactNode;
  /** In a set shown whole, the name opens this direction on its own. */
  onOpen?: (() => void) | null;
  boxHeight: number;
  boxWidth: number;
  /** Set for a direction on its own branch; the frame waits until it is ready. */
  branch: BranchPreviewState | null;
  branchName: string;
  /** Something is being dragged across the stage, so the frame must not take the pointer. */
  busy: boolean;
  designWidth: number;
  errored: boolean;
  frameHeight: number;
  /** A viewport width is chosen, so the frame sits on the stage as an artboard. */
  framed: boolean;
  /** Rendered by the person's own dev server, so its outage is this pane's. */
  fromApp: boolean;
  /** Which document this frame holds; a new one remounts it. */
  identity: string;
  loaded: boolean;
  name: string;
  onError: () => void;
  onReady: (identity: string, frame: HTMLIFrameElement) => void;
  onReload: () => void;
  /** The reader says the page frames after all; stop covering it. */
  onShowAnyway: () => void;
  onStartBranch: () => void;
  /** Left or right, while two panes share the stage. */
  order: number;
  paneScale: number;
  /** The page told the browser not to frame it; the pane says so instead of showing the browser's broken page. */
  refusal: FrameRefusal | null;
  /** Two panes, each drawn at its design width and scaled down to fit. */
  scaling: boolean;
  /** The right-hand pane of a comparison. */
  second: boolean;
  serverUp: boolean;
  shown: boolean;
  splitting: boolean;
  src: string;
  title: string;
  viewport: number | null;
}) {
  // Say the scale rather than let it be guessed from small type. The width is
  // the useful half: what the design is drawn at.
  const label = (
    <>
      {name}
      {scaling && (
        <span className="ml-1.5 font-normal text-[#8E8E96]">
          {Math.round(designWidth)}px · {Math.round(paneScale * 100)}%
        </span>
      )}
    </>
  );

  return (
    <div
      className={
        !shown
          ? "hidden"
          : splitting
            ? `relative min-w-0 flex-1 overflow-auto ${second ? "border-l border-[#232328]" : ""} ${
                scaling
                  ? "flex flex-col items-center justify-center gap-2.5"
                  : framed
                    ? "flex min-h-full justify-center p-6"
                    : ""
              }`
            : framed
              ? "flex min-h-full justify-center p-6"
              : "absolute inset-0"
      }
      style={splitting ? { order } : undefined}
    >
      {splitting && (
        // Two panes need names; one doesn't, since the rail shows the active
        // one. Scaled, the name sits on its artboard rather than stranded at
        // the pane's top.
        <div
          className={
            scaling
              ? "pointer-events-none z-10 flex justify-center"
              : "pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3"
          }
        >
          {onOpen === null ? (
            <span className={CHIP}>{label}</span>
          ) : (
            <button
              aria-label={`Open ${name} on its own`}
              className={`${CHIP} pointer-events-auto transition-colors hover:bg-[#2E2E2E] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60`}
              onClick={onOpen}
              type="button"
            >
              {label}
            </button>
          )}
        </div>
      )}
      <div
        className={
          scaling
            ? // Its own artboard, so the room around it reads as canvas
              // rather than as a pane that failed to fill.
              "relative shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.12)]"
            : framed
              ? `relative h-[calc(100dvh-48px)] shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.10)] transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
              : "relative size-full"
        }
        style={
          scaling
            ? { height: boxHeight, width: boxWidth }
            : framed
              ? { width: viewport ?? undefined }
              : undefined
        }
      >
        {/* The frame keeps its own size and is scaled whole, so media
            queries answer to the design width, not the pane. Overlays stay
            outside, since an error is no use at half size. */}
        <div
          className={scaling ? "relative origin-top-left" : "relative size-full"}
          style={
            scaling
              ? {
                  height: frameHeight,
                  transform: `scale(${paneScale})`,
                  width: designWidth,
                }
              : undefined
          }
        >
          {branch !== null && branch.status !== "ready" ? (
            <BranchOverlay branch={branchName} onStart={onStartBranch} state={branch} />
          ) : (
            <iframe
              className={`size-full border-0 bg-white ${busy ? "pointer-events-none" : ""}`}
              key={identity}
              onError={onError}
              onLoad={(event) => {
                const stamped = event.currentTarget.dataset.previewIdentity;

                // Cross-origin previews expose only the event. Same-origin ones
                // must have left about:blank with a readable document to count
                // as loaded.
                if (
                  stamped !== undefined &&
                  (!src.startsWith("/") || previewFrameIsReady(event.currentTarget))
                ) {
                  onReady(stamped, event.currentTarget);
                }
              }}
              data-preview={title}
              data-preview-identity={identity}
              src={src}
              title={`Preview: ${name}`}
            />
          )}
          {annotate}
        </div>
        {branch !== null && branch.status !== "ready" ? null : (
          <PaneOverlay
            errored={errored}
            fromApp={fromApp}
            loaded={loaded}
            onReload={onReload}
            onShowAnyway={onShowAnyway}
            refusal={refusal}
            serverUp={serverUp}
            src={src}
          />
        )}
        {cover}
        {/* A pane loaded before the server died keeps its render, so it says
            it's stale, but only for server-rendered panes; a file preview is
            as current as ever. */}
        {!serverUp && loaded && fromApp && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
            <span className="rounded-full bg-[#1C1C20]/90 px-2.5 py-1 text-[11px] font-medium text-amber-300/90 shadow-lg">
              Stale — dev server stopped
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
