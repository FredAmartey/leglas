import { isJsonRecord, isString, type JsonValue } from "../json.js";

/**
 * How the shell talks to its own server's write endpoints. A refusal comes
 * back as an Error carrying the server's own sentence ("A change is running.
 * Wait for it to finish."), which is the one worth putting on screen: it
 * says what to do, where a status code does not.
 */
export async function refusal(response: Response, fallback: string): Promise<Error> {
  const payload: JsonValue = await response.json().catch(() => null);
  const message = isJsonRecord(payload) ? payload.error : null;

  return new Error(isString(message) ? message : fallback);
}

/**
 * The body of an answer from this shell's own server.
 *
 * The one place the interface takes the server's word for a shape. Every
 * `/leglas/api` path is answered by the `@leglas/server` this shell shipped
 * with, in the same release, and `T` is the type that handler writes; nothing
 * else answers on this origin's path.
 */
export function readJson<T>(response: Response): Promise<T> {
  // SAFETY: the server that answers `/leglas/api` is the one this shell
  // was released with, and `T` names what its handler serialises.
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
