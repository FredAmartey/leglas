/**
 * The shell's one voice for what an action did, since a row that vanishes
 * silently reads as "did that work?". A toast names what happened, and hands
 * back the undo where there is one.
 *
 * Grouped by `kind`: repeated copies replace one line, while three removals
 * keep three undos, since each is a different offer.
 */
export type ToastTone = "danger" | "info" | "success";

export type Toast = {
  /** A single reversal offered inside the toast. */
  action?: { label: string; run: () => void } | undefined;
  /** Secondary line, selectable: the URL to copy by hand when the clipboard refuses. */
  detail?: string | undefined;
  /** Secondary line in prose: why something did not happen and what to do instead. */
  note?: string | undefined;
  id: number;
  /** What this toast is about; a new toast of the same kind replaces it. */
  kind: string;
  message: string;
  tone: ToastTone;
  /** Milliseconds on screen; null waits to be dismissed. */
  ttl: number | null;
};

/**
 * Toasts on screen at once. Past this the oldest goes, which can only drop an
 * undo the removed list still offers.
 */
export const TOAST_LIMIT = 3;

/**
 * A plain confirmation is read and forgotten; an undo has to outlast the moment
 * of doubt after the action.
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
