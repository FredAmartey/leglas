import type { Anchor } from "./anchor.js";
import type { JsonValue } from "../json.js";
import { readJson } from "../net/api.js";

export type Annotation = {
  id: string;
  title: string;
  note: string;
  anchor: Anchor;
};

export type NoteFetcher = (input: string, init?: RequestInit) => Promise<Response>;

const browserFetch: NoteFetcher = (input, init) => fetch(input, init);

export async function readNotes(fetcher: NoteFetcher = browserFetch): Promise<Annotation[]> {
  const response = await fetcher("/leglas/api/annotations");

  if (!response.ok) throw new Error("Leglas refused the notes.");
  const payload = await readJson<{ annotations?: Annotation[] }>(response);

  return payload.annotations ?? [];
}

async function post<T>(path: string, body: JsonValue, fetcher: NoteFetcher): Promise<T> {
  const response = await fetcher(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw new Error("Leglas refused the note.");
  const result = await readJson<{ ok?: boolean } & T>(response);

  if (result.ok !== true) throw new Error("Leglas refused the note.");

  return result;
}

export function addNote(
  title: string,
  note: string,
  anchor: Anchor,
  fetcher: NoteFetcher = browserFetch,
): Promise<{ annotation: Annotation }> {
  return post<{ annotation: Annotation }>(
    "/leglas/api/annotations",
    { anchor, note, title },
    fetcher,
  );
}

/** Rewords a note. Only the words go up; where it points is the half worth keeping. */
export function updateNote(
  id: string,
  note: string,
  fetcher: NoteFetcher = browserFetch,
): Promise<{ annotation: Annotation }> {
  return post<{ annotation: Annotation }>("/leglas/api/annotations/update", { id, note }, fetcher);
}

export function deleteNotes(
  ids: readonly string[],
  fetcher: NoteFetcher = browserFetch,
): Promise<{ deleted: number }> {
  return post<{ deleted: number }>("/leglas/api/annotations/delete", { ids }, fetcher);
}
