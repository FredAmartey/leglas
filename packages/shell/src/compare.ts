/**
 * Which direction the second pane should show.
 *
 * Opening a comparison should not require a second choice. An explicit pin
 * always wins. For a variant, the direction it is based on beats history,
 * because the question a variant set asks is "how far is this from the
 * original", and that comparison should be one keypress. Otherwise the
 * direction you were just looking at, which is almost always the one you
 * meant. A title that no longer exists is ignored rather than blanking the
 * pane.
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

/**
 * How one side of a split is drawn.
 *
 * A split halves the room, and an app given half the room does not draw a
 * smaller version of the same design: it crosses its own breakpoints and draws
 * a different one. Two directions meant for a wide window then get judged as
 * two narrow ones, and the winner is picked from a layout nobody ships.
 *
 * So the design keeps the width it would have had alone and the whole frame is
 * scaled to fit instead. Media queries answer against the frame, not the pane,
 * which is the entire point: nothing reflows, flipping and splitting agree
 * about what the design is, and a split costs only size.
 *
 * The frame keeps the stage's proportions too, not just its width. Stretching
 * it to fill the pane instead was tried, and it trades one distortion for
 * another: a hero sized to the viewport gets drawn in a window twice as tall,
 * so it comes back airier than it ships. The space left over is the honest
 * price of two full designs at once, and it reads as a canvas rather than as
 * waste once each frame is drawn as its own artboard.
 */
export function paneGeometry(state: {
  /** How much breathing room a framed preset sits in, both sides together. */
  gutter: number;
  panes: number;
  scaleSplit: boolean;
  stageHeight: number;
  stageWidth: number;
  /** An explicit viewport preset, or null to use the stage's own width. */
  viewport: number | null;
}): PaneGeometry {
  const { gutter, panes, scaleSplit, stageHeight, stageWidth, viewport } = state;

  // One pixel of divider sits between each pair of panes.
  const paneWidth = panes > 1 ? (stageWidth - (panes - 1)) / panes : stageWidth;
  const designWidth = viewport ?? Math.round(stageWidth);
  const room = paneWidth - (viewport !== null ? gutter : 0);

  const fits = scaleSplit && panes > 1 && stageWidth > 0 && designWidth > 0;
  // Never scale up. A design asked for 1440 does not get better at 1600, and a
  // single pane is already showing the design at its own size.
  const scale = fits ? Math.max(FLOOR, Math.min(1, room / designWidth)) : 1;
  const scaling = scale < UNSCALED;

  return {
    boxHeight: scaling ? stageHeight * scale : stageHeight,
    boxWidth: scaling ? designWidth * scale : stageWidth,
    designWidth,
    frameHeight: stageHeight,
    scale,
    scaling,
  };
}
