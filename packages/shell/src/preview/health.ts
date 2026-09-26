import type { Preview } from "../types.js";

/**
 * Whether a preview renders through the user's dev server, the only thing the
 * health probe knows about. File previews (served by Leglas), branch previews
 * (own checkout) and absolute URLs don't go down with the app. Mirrors the
 * CLI's needsApp.
 */
export function needsDevServer(preview: Preview): boolean {
  return preview.file === undefined && preview.branch === undefined && preview.url.startsWith("/");
}

export type HealthState = {
  reachable: boolean;
  /**
   * Whether the dev server has been down since the last handled recovery.
   * Restarts are routine, and without this panes that failed during the outage
   * stay broken until reloaded by hand.
   */
  wasDown: boolean;
};

export const INITIAL_HEALTH: HealthState = { reachable: true, wasDown: false };

/**
 * Folds a health probe into the state. Optimistic at boot, so a normal start
 * never flashes a recovery. `wasDown` latches on failure and is cleared by
 * whoever acts on it, so a recovery can't slip between polls. Returns the same
 * object when nothing changed, or every poll re-renders the interface.
 */
export function nextHealthState(current: HealthState, reachable: boolean): HealthState {
  if (!reachable) {
    return !current.reachable && current.wasDown ? current : { reachable: false, wasDown: true };
  }

  return current.reachable ? current : { reachable: true, wasDown: current.wasDown };
}
