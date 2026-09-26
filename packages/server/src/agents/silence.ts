/**
 * How long an agent may be silent before Leglas says so, and before it gives
 * up. Without a limit, a CLI stuck on a prompt nothing here can answer (trust,
 * approval) holds its run and the queue until someone presses Stop. But a model
 * thinking hard is silent too.
 *
 * Measured on 2026-09-22 as gaps between events within one turn: Claude Code on
 * the benchmark tasks went quiet 221 times, longest 2 minutes. Codex exec,
 * highest effort included, went quiet 18,517 times; 99.9% under 4 minutes, nine
 * past 10, the longest 19, each the model working out one reply.
 */

/** Past this, the card says how long the agent has been quiet. */
export const QUIET_NOTICE_MS = 3 * 60_000;

/** Past this, Leglas ends the run: half as long again as the longest silence measured. */
export const SILENCE_CEILING_MS = 30 * 60_000;
