/**
 * The value, or a thrown error naming what was missing, for tests and setup
 * that would rather fail on the spot.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`${what} is missing`);

  return value;
}
