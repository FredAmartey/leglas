export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A parsed JSON object can retain fields this version does not know about. */
export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
