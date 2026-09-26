import { isJsonRecord, isString, type JsonValue } from "../json.js";

/**
 * How the shell calls its server's write endpoints. A refusal becomes an Error
 * carrying the server's own sentence, which says what to do where a status code
 * doesn't.
 */
export async function refusal(response: Response, fallback: string): Promise<Error> {
  const payload: JsonValue = await response.json().catch(() => null);
  const message = isJsonRecord(payload) ? payload.error : null;

  return new Error(isString(message) ? message : fallback);
}

/**
 * The body of an answer from this shell's own server: the one place the
 * interface takes the server's word for a shape, since every `/leglas/api` path
 * is answered by the `@leglas/server` released with this shell.
 */
export function readJson<T>(response: Response): Promise<T> {
  // SAFETY: the server answering `/leglas/api` shipped with this shell, and `T`
  // names what its handler serialises.
  return response.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: JsonValue, fallback: string): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, fallback);

  return readJson<T>(response);
}
