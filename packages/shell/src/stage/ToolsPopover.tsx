import type { Prefs, VIEWPORTS } from "../prefs.js";
import { FONTS } from "../ui/fonts.js";
import { P, PIcon, ROW_BUTTON, Switch, Tip } from "../ui/kit.js";
import { TOAST_TTL, type Toast } from "../ui/toasts.js";

/**
 * What the floating widget opens: the typeface, the viewport, the overlays,
 * and the ways out to a new tab and to the keyboard list. Preferences, not
 * actions on the work, which is why the composer does not live here.
 */
export function ToolsPopover({
  applyOverlayPref,
  copied,
  fontKey,
  href,
  notify,
  onCopyReference,
  onShortcuts,
  open,
  parked,
  popoverRef,
  prefs,
  setPrefs,
  splitting,
  viewing,
  viewports,
}: {
  /** Hide or show a framework's dev overlay inside one open preview. */
  applyOverlayPref: (frame: HTMLIFrameElement, hide: boolean) => void;
  /** The active direction's reference was just copied. */
  copied: boolean;
  /** The key of the typeface in use. */
  fontKey: string;
  /** The active direction, for a tab of its own. */
  href: string;
  notify: (toast: Omit<Toast, "id">) => void;
  onCopyReference: () => void;
  onShortcuts: () => void;
  open: boolean;
  /** The widget is being dragged to a corner, so the panel is out of the layout. */
  parked: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  prefs: Prefs;
  setPrefs: (update: (prefs: Prefs) => Prefs) => void;
  splitting: boolean;
  viewing: boolean;
  viewports: typeof VIEWPORTS;
}) {
  return (
    <div
      aria-hidden={!open}
      aria-label="Leglas tools"
      className={`w-56 rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
        // Out of the layout entirely while dragging: hidden it still
        // occupies its full box, which is what pushed the button off the
        // pointer.
        parked ? "hidden " : ""
      }${
        open
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-1 scale-95 opacity-0"
      }`}
      inert={!open}
      ref={popoverRef}
      role="dialog"
      tabIndex={-1}
    >
      <span className="block px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
        Typeface
      </span>
      <div
        aria-label="Interface typeface"
        className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
        role="group"
      >
        {FONTS.map((font) => (
          <button
            aria-pressed={fontKey === font.key}
            className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
              fontKey === font.key
                ? "bg-[#2E2E2E] font-medium text-white"
                : "text-[#9CA3AF] hover:text-[#D1D5DB]"
            }`}
            key={font.key}
            onClick={() => setPrefs((prefs) => ({ ...prefs, font: font.key }))}
            style={{ fontFamily: font.stack }}
            type="button"
          >
            {font.label}
          </button>
        ))}
      </div>

      <span className="block px-1 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
        Viewport
      </span>
      <div
        aria-label="Viewport width"
        className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
        role="group"
      >
        {viewports.map(({ label, width }) => (
          <button
            className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
              prefs.viewport === width
                ? "bg-[#2E2E2E] font-medium text-white"
                : "text-[#9CA3AF] hover:text-[#D1D5DB]"
            }`}
            key={label}
            onClick={() => setPrefs((prefs) => ({ ...prefs, viewport: width }))}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Only meaningful while two things are on the stage, so it appears
        when it applies rather than sitting there greyed out. */}
      {splitting && (
        <button
          aria-checked={prefs.scaleSplit}
          className={`${ROW_BUTTON} mt-1 ${prefs.scaleSplit ? "text-white" : "text-[#9CA3AF]"}`}
          onClick={() => setPrefs((current) => ({ ...current, scaleSplit: !current.scaleSplit }))}
          role="switch"
          type="button"
        >
          <span>Scale each side to fit</span>
          <Switch on={prefs.scaleSplit} />
        </button>
      )}

      <span className="block px-1 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
        Dev overlays
      </span>
      <button
        aria-checked={prefs.showDevOverlays}
        className={`${ROW_BUTTON} ${prefs.showDevOverlays ? "text-white" : "text-[#9CA3AF]"}`}
        onClick={() => {
          const show = !prefs.showDevOverlays;
          setPrefs((current) => ({ ...current, showDevOverlays: show }));
          // Applied to every open pane at once, so the change is visible
          // without reloading anything.
          for (const frame of document.querySelectorAll("iframe")) {
            applyOverlayPref(frame as HTMLIFrameElement, !show);
          }
        }}
        role="switch"
        type="button"
      >
        <span>Show dev tool overlay</span>
        <Switch on={prefs.showDevOverlays} />
      </button>
      <button
        aria-checked={prefs.showWidget}
        className={`${ROW_BUTTON} ${prefs.showWidget ? "text-white" : "text-[#9CA3AF]"}`}
        onClick={() => {
          const show = !prefs.showWidget;
          setPrefs((current) => ({ ...current, showWidget: show }));
          // This switch lives inside the thing it hides, so the way back
          // is named the moment the door is closed, and for longer than
          // a plain confirmation: this one is teaching a key. The rail's
          // foot keeps a line saying the same for as long as it matters.
          if (!show) {
            notify({
              kind: "widget",
              message: "Press T to reopen the tools",
              tone: "info",
              ttl: TOAST_TTL.plain + 3000,
            });
          }
        }}
        role="switch"
        type="button"
      >
        <span>Show Leglas overlay</span>
        <Switch on={prefs.showWidget} />
      </button>

      {!viewing && (
        <button
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
          onClick={onCopyReference}
          type="button"
        >
          <PIcon d={P.copy} size={12} />
          {copied ? "Copied" : "Copy reference"}
        </button>
      )}
      <Tip label="Or double-click any direction in the rail">
        <a
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          <span className="inline-block size-3 rounded-sm border border-current" />
          Open in new tab
        </a>
      </Tip>
      <button
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
        onClick={onShortcuts}
        type="button"
      >
        <span>Keyboard shortcuts</span>
        <kbd className="rounded border border-[#232328] bg-[#2E2E2E]/60 px-1 py-0.5 font-sans text-[10px] text-[#84848C]">
          ?
        </kbd>
      </button>
    </div>
  );
}
