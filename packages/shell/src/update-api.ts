import type { UpdateStatus } from "./types.js";

/**
 * The update endpoints, as the panel calls them. A refusal comes back as an
 * Error carrying the server's own sentence ("A change is running. Wait for
 * it to finish."), which is the one worth putting on screen.
 */
async function refusal(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof payload?.error === "string" ? payload.error : fallback);
}

export async function readUpdate(signal?: AbortSignal): Promise<UpdateStatus> {
  const response = await fetch("/leglas/api/update", signal === undefined ? {} : { signal });
  if (!response.ok) throw await refusal(response, `the server answered ${response.status}`);
  return response.json() as Promise<UpdateStatus>;
}

async function updateWrite(path: string, body: unknown, fallback: string): Promise<UpdateStatus> {
  const response = await fetch(`/leglas/api/update${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await refusal(response, fallback);
  return response.json() as Promise<UpdateStatus>;
}

/** Ask npm now, whatever the cache says. Resolves once npm has answered or given up. */
export function checkForUpdate(): Promise<UpdateStatus> {
  return updateWrite("/check", {}, "Leglas could not check for updates.");
}

export function skipUpdate(version: string): Promise<UpdateStatus> {
  return updateWrite("/skip", { version }, "Leglas could not skip that version.");
}

/** Resolves as soon as the install has started; the phase says the rest. */
export function installUpdate(): Promise<UpdateStatus> {
  return updateWrite("/install", {}, "Leglas could not start the update.");
}
