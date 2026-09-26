/**
 * What JSON can carry, so a value from the wire or storage promises no more
 * than JSON does. A field of a `JsonRecord` is a `JsonValue`, narrowed by a
 * predicate before use.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonRecord = { readonly [key: string]: JsonValue };

/** `JSON.parse`, typed by what it can return rather than as anything at all. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/**
 * An object with keys, as JSON or structured clone makes one. Which keys is the
 * caller's next question.
 */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}
