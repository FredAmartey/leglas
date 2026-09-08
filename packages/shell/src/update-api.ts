import { postJson, refusal } from "./api.js";
import type { UpdateStatus } from "./types.js";

/** The update endpoints, as the panel calls them. */
export async function readUpdate(signal?: AbortSignal): Promise<UpdateStatus> {
  const response = await fetch("/leglas/api/update", signal === undefined ? {} : { signal });
  if (!response.ok) throw await refusal(response, `the server answered ${response.status}`);
  return response.json() as Promise<UpdateStatus>;
}

/** Ask npm now, whatever the cache says. Resolves once npm has answered or given up. */
export function checkForUpdate(): Promise<UpdateStatus> {
  return postJson("/leglas/api/update/check", {}, "Leglas could not check for updates.");
}

export function skipUpdate(version: string): Promise<UpdateStatus> {
  return postJson("/leglas/api/update/skip", { version }, "Leglas could not skip that version.");
}

/** Resolves as soon as the install has started; the phase says the rest. */
export function installUpdate(): Promise<UpdateStatus> {
  return postJson("/leglas/api/update/install", {}, "Leglas could not start the update.");
}
