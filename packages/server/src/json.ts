export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

/** Decode JSON before a boundary reader checks the fields it consumes. */
export function parseJson(text: string): JsonValue {
  // SAFETY: `JSON.parse` without a reviver produces only JSON values.
  return JSON.parse(text) as JsonValue;
}

/** Recognize a JSON object container; callers validate the fields they consume. */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
