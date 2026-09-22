/**
 * How long an agent may go without a word before Leglas says so, and before
 * it gives up on it.
 *
 * A vendor CLI that stops to ask something nothing in Leglas can answer, a
 * trust prompt or an approval, used to hold its run until somebody noticed
 * and pressed Stop, and every request queued behind it waited too. The catch
 * is that a long silence is also what a model thinking hard looks like: its
 * stream carries nothing until the whole answer is ready.
 *
 * So the numbers are measured, not guessed. On 2026-09-22, over unattended
 * runs, as the time between two events inside one turn: Claude Code on the
 * benchmark tasks went quiet 221 times, the longest for 2 minutes (a shell
 * command). Codex exec, including runs at its highest reasoning effort, went
 * quiet 18,517 times; 99.9% of those were under 4 minutes, nine passed 10
 * minutes and the longest lasted 19, every one of them the model working out
 * a single reply.
 */

/** Past this, the card says how long the agent has been quiet. */
export const QUIET_NOTICE_MS = 3 * 60_000;

/** Past this, Leglas ends the run: half as long again as the longest silence measured. */
export const SILENCE_CEILING_MS = 30 * 60_000;
