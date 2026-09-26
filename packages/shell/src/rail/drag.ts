/** A row being dragged to a new place in the rail. */
export type Drag = {
  dy: number;
  from: number;
  /** Gap between rows, measured at drag start so shifts clear it. */
  gap: number;
  /** Dragged row height, captured at drag start for render-time shifts. */
  height: number;
  title: string;
  /** After release: easing into the target slot before the order commits. */
  settling: boolean;
  started: boolean;
  to: number;
  /** Pushed past the slots it can take; the reason shows on the row. */
  blocked: boolean;
  /**
   * Rows measured since the drag began. A lineage rail folds families around
   * the dragged row at the start, so positions from the press are stale until
   * that fold lays out.
   */
  measured: boolean;
  /** Why the row cannot go where it is being pushed; null when anywhere goes. */
  reason: string | null;
  /** First and last row index the row may take; null means the whole rail. */
  span: [number, number] | null;
};

/** What a drag measured at the press, kept out of state because nothing draws from it. */
export type DragMeta = {
  maxDy: number;
  minDy: number;
  rows: { height: number; mid: number; title: string; top: number }[];
  startX: number;
  startY: number;
  suppressed: boolean;
  /** Where the dragged row sat at the press, to keep it under the pointer across the fold. */
  oldTop: number;
  /** On a lineage rail: the rows it may be ordered among, and what they hang from. */
  parent: string | null;
  siblings: readonly string[];
};
