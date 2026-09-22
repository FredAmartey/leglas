import { useEffect, useRef } from "react";

/** Asks before a removed direction, or all of them, is deleted for good. */
export function DeleteRemovedDialog({
  busy,
  count,
  error,
  fallbackFocusRef,
  name,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  count: number;
  error: string | null;
  fallbackFocusRef: React.RefObject<HTMLElement | null>;
  name: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onDialogCancel = (event: Event) => {
      event.preventDefault();
      onCancelRef.current();
    };

    const onDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const controls = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );

      const first = controls[0];
      const last = controls.at(-1);

      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("cancel", onDialogCancel);
    dialog.addEventListener("keydown", onDialogKeyDown);

    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();

    return () => {
      dialog.removeEventListener("cancel", onDialogCancel);
      dialog.removeEventListener("keydown", onDialogKeyDown);

      if (dialog.open) dialog.close();
      (returnTo?.isConnected ? returnTo : fallbackFocusRef.current)?.focus();
    };
  }, []);

  const single = count === 1;
  const title = single ? "Delete removed direction?" : "Clear removed directions?";

  const description = single
    ? `This permanently removes “${name ?? "this direction"}” from Leglas.`
    : `This permanently removes all ${count} directions from Leglas.`;

  return (
    <dialog
      aria-describedby="delete-removed-description"
      aria-labelledby="delete-removed-title"
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-3rem)] max-w-none overflow-visible border-0 bg-transparent p-0 text-left text-inherit backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
    >
      <div className="w-[calc(100vw-3rem)] max-w-sm overscroll-contain rounded-lg border border-[#232328] bg-[#1E1E22] p-4 shadow-2xl">
        <h2 className="text-sm font-medium text-white" id="delete-removed-title">
          {title}
        </h2>
        <div
          className="mt-2 space-y-1 text-xs leading-relaxed text-[#9CA3AF]"
          id="delete-removed-description"
        >
          <p>{description}</p>
          <p>Source files and shared project config stay untouched.</p>
        </div>
        {error !== null ? (
          <p className="mt-3 text-xs leading-relaxed text-red-300" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-md px-3 py-1.5 text-xs text-[#D1D5DB] transition-[background-color,color,scale] hover:bg-white/[0.06] hover:text-white active:scale-[0.96] disabled:opacity-50"
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white transition-[background-color,scale] hover:bg-red-500 active:scale-[0.96] disabled:opacity-60"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Deleting…" : single ? "Delete" : "Delete all"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
