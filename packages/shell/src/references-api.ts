import { headerName } from "./references.js";

export type ReferenceFetcher = (input: string, init?: RequestInit) => Promise<Response>;

const browserFetch: ReferenceFetcher = (input, init) => fetch(input, init);

export type UploadedReference = { id: string; file: string };

/**
 * Hand one image to Leglas, which keeps it under `.leglas/references/` until
 * a request claims it.
 *
 * The body is the file itself rather than a multipart form: one image per
 * call, its type in the content-type header, its name in a header of ours.
 * The server decides what it is from the bytes, so nothing here has to be
 * trusted, only carried.
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
  const result = (await response.json()) as {
    ok?: unknown;
    reference?: { id?: unknown; file?: unknown };
  };
  const id = result.reference?.id;
  const path = result.reference?.file;
  if (result.ok !== true || typeof id !== "string" || typeof path !== "string") {
    throw new Error("Leglas refused the image.");
  }
  return { id, file: path };
}
