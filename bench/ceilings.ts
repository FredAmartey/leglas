import type { Counts } from "./journeys.ts";

/**
 * The ratchet. Every count has one exact ceiling, and a count that is absent
 * is zero on either side. Above its ceiling is a regression. Below it is a
 * stale ceiling, which fails too until `--update` lowers it, so a win can't
 * quietly leave room to slide back. Raising takes a reason, logged in `raised`.
 */

export type Raise = { count: string; from: number; to: number; why: string; on: string };

export type CeilingFile = { ceilings: Record<string, Counts>; raised: Raise[] };

export type Status = "ok" | "regression" | "stale";

export type Verdict = { count: string; ceiling: number; measured: number; status: Status };

function isCounts(value: unknown): value is Counts {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => Number.isInteger(entry) && entry >= 0)
  );
}

function isRaise(value: unknown): value is Raise {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    typeof value.count === "string" &&
    "from" in value &&
    typeof value.from === "number" &&
    "to" in value &&
    typeof value.to === "number" &&
    "why" in value &&
    typeof value.why === "string" &&
    "on" in value &&
    typeof value.on === "string"
  );
}

function isCeilingFile(value: unknown): value is CeilingFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "ceilings" in value &&
    typeof value.ceilings === "object" &&
    value.ceilings !== null &&
    Object.values(value.ceilings).every(isCounts) &&
    "raised" in value &&
    Array.isArray(value.raised) &&
    value.raised.every(isRaise)
  );
}

export function parseCeilings(text: string): CeilingFile {
  const parsed: unknown = JSON.parse(text);

  if (!isCeilingFile(parsed)) {
    throw new Error(
      "bench/ceilings.json is not { ceilings: { journey: { count: n } }, raised: [] }.",
    );
  }

  return parsed;
}

/** Sorted, so a change to one ceiling is a one-line diff. */
export function formatCeilings(file: CeilingFile): string {
  const sorted = (counts: Counts) =>
    Object.fromEntries(
      Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)),
    );

  const ceilings = Object.fromEntries(
    Object.entries(file.ceilings)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([journey, counts]) => [journey, sorted(counts)]),
  );

  return `${JSON.stringify({ ceilings, raised: file.raised }, null, 2)}\n`;
}

function names(...sides: Counts[]): string[] {
  return [...new Set(sides.flatMap((side) => Object.keys(side)))].sort();
}

export function compare(ceilings: Counts, measured: Counts): Verdict[] {
  return names(ceilings, measured).map((count) => {
    const ceiling = ceilings[count] ?? 0;
    const value = measured[count] ?? 0;

    const status: Status = value > ceiling ? "regression" : value < ceiling ? "stale" : "ok";

    return { count, ceiling, measured: value, status };
  });
}

/**
 * Brings every stale ceiling down to what was measured and leaves the rest:
 * update never raises. A count measured at zero keeps its line only if the
 * journey always reports it.
 */
export function lower(ceilings: Counts, measured: Counts, varied: readonly string[] = []): Counts {
  const next: Counts = {};

  for (const count of names(ceilings, measured)) {
    // A count that differed between runs has no one value to lower to.
    const value = varied.includes(count)
      ? (ceilings[count] ?? 0)
      : Math.min(ceilings[count] ?? 0, measured[count] ?? 0);

    if (value > 0 || count in measured || varied.includes(count)) next[count] = value;
  }

  return next;
}

/** `boot.processes.lsof` is the count `processes.lsof` of the journey `boot`. */
export function splitCount(name: string): { journey: string; count: string } | null {
  const dot = name.indexOf(".");

  if (dot <= 0 || dot === name.length - 1) return null;

  return { journey: name.slice(0, dot), count: name.slice(dot + 1) };
}

/**
 * The ceilings that rose since `base` with no new entry in `raised` saying so.
 * A count new to a journey rose from zero, so it needs an entry too. A journey
 * new since `base` has nothing to rise from: its first ceilings are whatever
 * `--update` measured, reviewed with the code that added it. An entry with a
 * blank reason explains nothing, since the file can be edited by hand.
 */
export function unexplainedRaises(base: CeilingFile, head: CeilingFile): string[] {
  const logged = new Set(base.raised.map((entry) => JSON.stringify(entry)));

  const fresh = head.raised.filter(
    (entry) => entry.why.trim() !== "" && !logged.has(JSON.stringify(entry)),
  );

  const unexplained: string[] = [];

  for (const [journey, counts] of Object.entries(head.ceilings)) {
    const before = base.ceilings[journey];

    if (before === undefined) continue;

    for (const [count, ceiling] of Object.entries(counts)) {
      const name = `${journey}.${count}`;

      if (ceiling <= (before[count] ?? 0)) continue;

      if (!fresh.some((entry) => entry.count === name && entry.to === ceiling)) {
        unexplained.push(`${name} rose from ${before[count] ?? 0} to ${ceiling}`);
      }
    }
  }

  return unexplained;
}
