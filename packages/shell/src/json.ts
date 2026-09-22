/**
 * What JSON can carry, named so a value read off the wire or out of storage
 * has a type that promises no more than JSON does. Reading a field off a
 * `JsonRecord` gives a `JsonValue` back, and a predicate says what it is
 * before it is used as anything narrower.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonRecord = { readonly [key: string]: JsonValue };

/** `JSON.parse`, typed by what it can return rather than as anything at all. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/**
 * An object with keys, as JSON or a structured clone would produce one. This
 * says nothing about which keys; that is the caller's next question.
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
