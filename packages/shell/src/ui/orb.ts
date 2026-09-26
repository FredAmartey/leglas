/**
 * Which face a wait wears. Thinking orbs mark a loading pane and a duplicate
 * verdict still being earned. One animation each became a fixture nobody sees,
 * so one mood is drawn per page load: every orb in a session agrees, and a
 * reload deals again.
 */
import type { OrbState } from "thinking-orbs";

/** The moods a wait may wear. A subset of the shipped states, chosen by eye. */
export const ORB_MOODS = [
  "searching",
  "solving",
  "composing",
  "breathing",
  "shaping",
] as const satisfies readonly OrbState[];

/** Maps a roll in [0, 1) to a mood. Out-of-range rolls clamp to the ends. */
export function orbMood(roll: number): OrbState {
  const index = Math.floor(roll * ORB_MOODS.length);

  return ORB_MOODS[Math.min(ORB_MOODS.length - 1, Math.max(0, index))] ?? ORB_MOODS[0];
}

/** This load's mood, shared by every orb until the next reload redraws. */
export const MOOD = orbMood(Math.random());
