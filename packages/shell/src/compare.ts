/**
 * Which direction the second pane should show.
 *
 * Opening a comparison should not require a second choice. The direction you
 * want beside this one is almost always the one you were just looking at, so
 * history is the default and an explicit pin overrides it. A pin that no
 * longer exists is ignored rather than blanking the pane.
 */
export function nextCompare(state: {
  active: string;
  previous: string | null;
  pinned: string | null;
  rows?: readonly string[];
}): string | null {
  const rows = state.rows;
  const exists = (title: string | null): title is string =>
    title !== null && title !== state.active && (rows === undefined || rows.includes(title));

  if (exists(state.pinned)) return state.pinned;
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
