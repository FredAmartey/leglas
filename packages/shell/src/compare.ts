/**
 * Which direction the second pane should show.
 *
 * Opening a comparison should not require a second choice. An explicit pin
 * always wins. For a shade, the direction it is based on beats history,
 * because the question a shade set asks is "how far is this from the
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
