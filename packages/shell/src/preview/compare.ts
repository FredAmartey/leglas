/**
 * Which direction the second pane shows, with no second choice needed. A pin
 * wins; for a variant, its parent (the question a variant set asks); otherwise
 * the direction just viewed. A title that no longer exists is ignored rather
 * than blanking the pane.
 */
export function nextCompare(state: {
  active: string;
  previous: string | null;
  pinned: string | null;
  parent?: string | null;
  rows?: readonly string[];
}): string | null {
  const rows = state.rows;

  const exists = (title: string | null | undefined): title is string =>
    title != null && title !== state.active && (rows === undefined || rows.includes(title));

  if (exists(state.pinned)) return state.pinned;

  if (exists(state.parent)) return state.parent;

  if (exists(state.previous)) return state.previous;

  return rows?.find((title) => title !== state.active) ?? null;
}

/** The directions on stage, left to right. */
export function paneTitles(state: {
  active: string;
  compare: string | null;
  split: boolean;
}): string[] {
  if (!state.split || state.compare === null || state.compare === state.active) {
    return [state.active];
  }

  return [state.active, state.compare];
}

export type PaneGeometry = {
  /** Width the design is drawn at, in its own pixels. */
  designWidth: number;
  /** Height the design is drawn at, in its own pixels. */
  frameHeight: number;
  /** 1 means the design is at its own size and nothing is transformed. */
  scale: number;
  scaling: boolean;
  /** The box the scaled design occupies on screen. */
  boxHeight: number;
  boxWidth: number;
};

/** Below this a scale is not worth the transform, and rounding lies about it. */
const UNSCALED = 0.999;

/** A pane can be dragged narrow enough to divide by almost nothing. */
const FLOOR = 0.05;

/** What a scaled frame needs above it in a grid cell: the name it wears and the gap under it. */
export const LABEL_ROOM = 40;

/**
 * How a set shown whole is arranged: one row for up to three, so each stays as
 * large as a split's, then two rows. Four sit two by two, not three and one.
 */
export type SetLayout = { columns: number; rows: number };

export function setLayout(count: number): SetLayout {
  if (count <= 3) return { columns: Math.max(1, count), rows: 1 };

  if (count === 4) return { columns: 2, rows: 2 };

  return { columns: 3, rows: Math.ceil(count / 3) };
}

/**
 * How one side of a split is drawn. An app given half the room crosses its
 * breakpoints and draws a different design, so two wide-window directions would
 * be judged as narrow ones. The design keeps its solo width and the frame is
 * scaled instead: media queries answer to the frame, nothing reflows, and a
 * split costs only size.
 *
 * The frame keeps the stage's proportions too. Stretching it to fill the pane
 * drew viewport-sized heroes in a window twice as tall; the leftover space
 * reads as canvas once each frame is its own artboard.
 */
export function paneGeometry(state: {
  /** How much breathing room a framed preset sits in, both sides together. */
  gutter: number;
  /** Panes side by side in a row. */
  panes: number;
  /** Rows of them, for a set shown whole; one otherwise. */
  rows?: number;
  /** Room kept clear around each frame, so designs side by side read as separate artboards. */
  inset?: number;
  scaleSplit: boolean;
  stageHeight: number;
  stageWidth: number;
  /** An explicit viewport preset, or null to use the stage's own width. */
  viewport: number | null;
}): PaneGeometry {
  const { gutter, panes, scaleSplit, stageHeight, stageWidth, viewport } = state;
  const rows = state.rows ?? 1;
  const inset = state.inset ?? 0;

  // One pixel of divider sits between each pair of panes.
  const paneWidth = panes > 1 ? (stageWidth - (panes - 1)) / panes : stageWidth;
  // Not rounded: the unsplit view uses the stage's fractional width, and
  // rounding could put a breakpoint on the other side in a split.
  const designWidth = viewport ?? stageWidth;
  const room = paneWidth - (viewport !== null ? gutter : 0) - inset;

  // A framed preset is inset by the gutter top and bottom, so its height is the
  // stage less the gutter; scaling from the full height would draw it 48px
  // taller and misplace `vh` layouts.
  const designHeight = stageHeight - (viewport !== null ? gutter : 0);

  const fits = scaleSplit && (panes > 1 || rows > 1) && stageWidth > 0 && designWidth > 0;
  // In a grid the frame must fit the cell's height below its name; in one row
  // the proportions already guarantee it.
  const cellHeight = (stageHeight - (rows - 1)) / rows;
  const byHeight = rows > 1 ? (cellHeight - LABEL_ROOM - inset) / designHeight : 1;
  // Never scale up: a 1440 design isn't better at 1600, and one pane already
  // shows it at its own size.
  const scale = fits ? Math.max(FLOOR, Math.min(1, room / designWidth, byHeight)) : 1;
  const scaling = scale < UNSCALED;

  return {
    boxHeight: designHeight * scale,
    boxWidth: designWidth * scale,
    designWidth,
    frameHeight: designHeight,
    scale,
    scaling,
  };
}
