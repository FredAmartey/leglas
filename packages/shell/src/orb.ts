/**
 * Which face a wait wears.
 *
 * The thinking orbs mark two kinds of waiting: a pane still loading and a
 * duplicate verdict still being earned. Pinning one animation to each made
 * the wait a fixture, and fixtures go unseen. Instead one mood is drawn per
 * page load from a handful of the shipped states, so every orb in a session
 * agrees with the others and a reload deals a new hand.
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

/**
 * Map one roll of [0, 1) onto a mood. Out-of-range rolls clamp to the ends,
 * so a bad roll degrades to a fixed mood rather than an undefined state.
 */
export function orbMood(roll: number): OrbState {
  const index = Math.floor(roll * ORB_MOODS.length);
  return ORB_MOODS[Math.min(ORB_MOODS.length - 1, Math.max(0, index))] as OrbState;
}

/** This load's mood, shared by every orb until the next reload redraws. */
export const MOOD = orbMood(Math.random());
