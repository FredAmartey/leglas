/**
 * How the shell talks to its own server's write endpoints. A refusal comes
 * back as an Error carrying the server's own sentence ("A change is running.
 * Wait for it to finish."), which is the one worth putting on screen: it
 * says what to do, where a status code does not.
 */
export async function refusal(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof payload?.error === "string" ? payload.error : fallback);
}

export async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await refusal(response, fallback);
  return response.json() as Promise<T>;
}

