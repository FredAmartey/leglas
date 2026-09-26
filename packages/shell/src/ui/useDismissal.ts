import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The dismissal every panel on a control shares: open, it takes focus; Escape,
 * a pointer outside or the window losing focus closes it; Escape returns focus
 * to the control. `onClose` is read through a ref so wiring attaches once per
 * opening.
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
      const target = event.target instanceof Node ? event.target : null;

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
