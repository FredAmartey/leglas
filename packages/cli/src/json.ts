export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A parsed JSON object can retain fields this version does not know about. */
export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** A response's body as JSON, or null when it is not JSON. */
export async function bodyOf(response: Response): Promise<JsonValue> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}
