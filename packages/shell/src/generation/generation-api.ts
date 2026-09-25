import { readJson, refusal } from "../net/api.js";
import type { GenerationJob } from "./generation.js";

/**
 * The generate endpoints, as the rail calls them. A refusal comes back as an
 * Error carrying the server's own sentence ("Building directions runs on
 * Claude for now…"), which says what to do where a status code would not.
 */
export async function readGenerations(signal?: AbortSignal): Promise<GenerationJob[]> {
  const response = await fetch("/leglas/api/generate", signal === undefined ? {} : { signal });

  if (!response.ok) throw new Error(`the server answered ${response.status}`);

  return (await readJson<{ jobs: GenerationJob[] }>(response)).jobs;
}

async function post(path: string, body: Record<string, string | number>, fallback: string) {
  const response = await fetch(`/leglas/api/generate${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, fallback);

  return response;
}

export async function startGeneration(body: {
  surface: string;
  brief: string;
  count: number;
}): Promise<GenerationJob> {
  const response = await post("", body, "Leglas could not start building the directions.");

  return (await readJson<{ job: GenerationJob }>(response)).job;
}

/** Stop one direction, or the whole set when no slot is named. */
export async function stopGeneration(id: string, slot?: string): Promise<void> {
  await post("/stop", slot === undefined ? { id } : { id, slot }, "Leglas could not stop it.");
}

export async function retryDirection(id: string, slot: string): Promise<void> {
  await post("/retry", { id, slot }, "Leglas could not build it again.");
}

export async function replaceDirection(id: string, slot: string): Promise<void> {
  await post("/replace", { id, slot }, "Leglas could not ask for a new idea.");
}
