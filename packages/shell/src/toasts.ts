/**
 * The shell's one voice for saying what an action did.
 *
 * Copy, rename and remove all used to be silent. Copy flashed a tick on its
 * own button and the other two just changed the rail, which reads as "did that
 * work?" the moment the row you were looking at is gone. A toast says the
 * thing out loud, names what it happened to, and — where the action can be
 * taken back — hands back the undo instead of making someone hunt for the
 * removed list.
 *
 * Toasts are grouped by `kind` rather than queued blindly: hammering copy
 * replaces one line instead of stacking five, while removing three directions
 * keeps three separate undos, because each one is a different offer.
 */
export type ToastTone = "danger" | "info" | "success";

export type Toast = {
  /** A single reversal offered inside the toast. */
  action?: { label: string; run: () => void } | undefined;
  /** Secondary line, selectable: the URL to copy by hand when the clipboard refuses. */
  detail?: string | undefined;
  id: number;
  /**
   * What this toast is about. A new toast of the same kind supersedes the old
   * one, so repeats replace rather than pile up.
   */
  kind: string;
  message: string;
  tone: ToastTone;
  /** Milliseconds on screen; null waits to be dismissed. */
  ttl: number | null;
};

/**
 * Toasts on screen at once. Past this the oldest goes, which can only ever
 * drop an undo that the removed list still offers a slower path to.
 */
export const TOAST_LIMIT = 3;

/**
 * A plain confirmation is read and forgotten; one carrying an undo has to
 * outlive the moment of doubt that follows the action.
 */
export const TOAST_TTL = { action: 6000, plain: 2600 } as const;

export function pushToast(
  toasts: readonly Toast[],
  toast: Toast,
  limit: number = TOAST_LIMIT,
): Toast[] {
  const kept = toasts.filter((entry) => entry.kind !== toast.kind);
  return [...kept, toast].slice(-limit);
}

export function dismissToast(toasts: readonly Toast[], id: number): Toast[] {
  return toasts.filter((toast) => toast.id !== id);
}
