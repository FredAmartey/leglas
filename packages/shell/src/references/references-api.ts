import { headerName } from "./references.js";
import { isString, type JsonValue } from "../json.js";
import { readJson } from "../net/api.js";

export type ReferenceFetcher = (input: string, init?: RequestInit) => Promise<Response>;

const browserFetch: ReferenceFetcher = (input, init) => fetch(input, init);

export type UploadedReference = { id: string; file: string };

/**
 * Hands one image to Leglas, which keeps it under `.leglas/references/` until a
 * request claims it. The body is the file itself, not multipart: its type in
 * content-type, its name in our own header. The server identifies it from the
 * bytes, so nothing here is trusted.
 */
export async function uploadReference(
  file: Blob & { name?: string },
  fetcher: ReferenceFetcher = browserFetch,
): Promise<UploadedReference> {
  const response = await fetcher("/leglas/api/references", {
    body: file,
    headers: {
      "content-type": file.type,
      "x-leglas-filename": headerName(file.name ?? ""),
    },
    method: "POST",
  });

  if (!response.ok) throw new Error("Leglas refused the image.");

  const result = await readJson<{
    ok?: boolean;
    reference?: { id?: JsonValue; file?: JsonValue };
  }>(response);

  const id = result.reference?.id;
  const path = result.reference?.file;

  if (result.ok !== true || !isString(id) || !isString(path)) {
    throw new Error("Leglas refused the image.");
  }

  return { id, file: path };
}
