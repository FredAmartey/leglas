import { useEffect, useRef } from "react";

import { shortcutList } from "./keymap.js";

/**
 * The keymap, on ? and from the tools popover.
 *
 * It reads SHORTCUTS rather than restating the bindings, so the list cannot
 * describe a key that no longer does anything.
 */
export function HelpOverlay({
  mac,
  onClose,
  viewer,
}: {
  mac: boolean;
  onClose: () => void;
  viewer: boolean;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const shortcuts = shortcutList(mac, viewer);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        className="w-full max-w-sm rounded-lg border border-[#232328] bg-[#1E1E22] p-4 shadow-2xl focus:outline-none"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <span className="block pb-3 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
          Keyboard
        </span>
        <dl className="flex flex-col gap-2.5">
          {shortcuts.map((shortcut) => (
            <div className="flex items-baseline justify-between gap-4" key={shortcut.label}>
              <dt className="flex shrink-0 items-baseline gap-1">
                {shortcut.keys.map((cap, index) => (
                  <span className="flex items-baseline gap-1" key={cap}>
                    {index > 0 && shortcut.join ? (
                      <span className="text-[10px] text-[#84848C]">{shortcut.join}</span>
                    ) : null}
                    <kbd className="rounded border border-[#232328] bg-[#2E2E2E]/60 px-1.5 py-0.5 font-sans text-[11px] text-[#E8E8EA]">
                      {cap}
                    </kbd>
                  </span>
                ))}
              </dt>
              <dd className="text-right text-xs leading-snug text-[#9CA3AF]">{shortcut.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
