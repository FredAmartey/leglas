import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The dismissal contract every panel hung off a control shares: while open
 * it takes focus, and Escape, a pointer landing outside it or the window
 * losing focus close it, with focus handed back to the control on Escape.
 *
 * `onClose` is read through a ref by the listeners, so the wiring is
 * attached once per opening rather than once per render of the shell.
 */
export function useDismissal(
  open: boolean,
  panelRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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
  }, [open, panelRef, triggerRef]);
}
