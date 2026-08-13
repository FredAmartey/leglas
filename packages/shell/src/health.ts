import type { Preview } from "./types.js";

/**
 * Whether a preview renders through the user's dev server, which is the only
 * thing the health probe knows anything about. A file preview is served by
 * Leglas itself, a branch preview by its own checkout, and an absolute URL by
 * whatever it names — none of them go down with the app, so none of them
 * should wear its outage. Mirrors the CLI's needsApp predicate so both ends
 * agree on who depends on the server.
 */
export function needsDevServer(preview: Preview): boolean {
  return (
    preview.file === undefined && preview.branch === undefined && preview.url.startsWith("/")
  );
}

export type HealthState = {
  reachable: boolean;
  /**
   * Whether the dev server has been down since the last recovery was handled.
   * Restarting a dev server is routine, so coming back has to be noticed:
   * without this, panes that failed during the outage stay broken until the
   * user reloads each one by hand.
   */
  wasDown: boolean;
};

export const INITIAL_HEALTH: HealthState = { reachable: true, wasDown: false };

/**
 * Fold a health probe into the current state.
 *
 * Optimistic at boot, so an ordinary start never flashes a recovery. The
 * `wasDown` flag latches on failure and is cleared by whoever acts on it, not
 * here, so a recovery cannot be missed between polls.
 */
export function nextHealthState(current: HealthState, reachable: boolean): HealthState {
  if (!reachable) return { reachable: false, wasDown: true };
  return { reachable: true, wasDown: current.wasDown };
}
