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
