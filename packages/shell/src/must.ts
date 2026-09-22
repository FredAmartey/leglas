/**
 * The value, or a thrown error that names what was missing. For tests and
 * setup that would rather fail on the spot than carry a null around.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`${what} is missing`);

  return value;
}
