import { readJson, refusal } from "../net/api.js";
import type { ShareRequest } from "./share.js";
import type { ShareStatus, TunnelProviderId } from "../types.js";
import type { JsonRecord } from "../json.js";

/**
 * The share endpoints as the panel calls them. A refusal becomes an Error
 * carrying the server's sentence ("Branch directions can't be shared yet"),
 * which says what to do.
 */
export type SharePayload = {
  share: ShareStatus | null;
  /** Tunnel programs found on this machine, in the order Leglas would pick. */
  tunnels: TunnelProviderId[];
};

export async function readShare(signal?: AbortSignal): Promise<SharePayload> {
  const response = await fetch("/leglas/api/share", signal === undefined ? {} : { signal });

  if (!response.ok) throw new Error(`the server answered ${response.status}`);

  return readJson<SharePayload>(response);
}

export async function startShare(
  body: ShareRequest & { tunnel?: TunnelProviderId | "none" },
): Promise<ShareStatus> {
  const response = await fetch("/leglas/api/share", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, "Leglas could not start sharing.");
  const payload = await readJson<{ share: ShareStatus }>(response);

  return payload.share;
}

export async function updateShare(body: ShareRequest): Promise<ShareStatus> {
  const response = await fetch("/leglas/api/share/update", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, "Leglas could not update the share.");
  const payload = await readJson<{ share: ShareStatus }>(response);

  return payload.share;
}

async function shareWrite(path: string, body: JsonRecord, fallback: string): Promise<ShareStatus> {
  const response = await fetch(`/leglas/api/share${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, fallback);
  const payload = await readJson<{ share: ShareStatus }>(response);

  return payload.share;
}

/** Let a path through that a listed share turned away. */
/**
 * `subtree` is the folder button. It travels with the request, not on a
 * trailing slash, since a refused directory index ends in one and Allow on it
 * must not become the folder.
 */
export function allowRoute(path: string, subtree = false): Promise<ShareStatus> {
  return shareWrite("/allow", { path, subtree }, "Leglas could not allow that path.");
}

/** A second link to the same share, named so the panel can say whose it is. */
export function createGrant(name: string): Promise<ShareStatus> {
  return shareWrite("/grants", { name }, "Leglas could not make another link.");
}

export function revokeGrant(id: string): Promise<ShareStatus> {
  return shareWrite("/grants/revoke", { id }, "Leglas could not turn that link off.");
}

export function extendGrant(id: string): Promise<ShareStatus> {
  return shareWrite("/grants/extend", { id }, "Leglas could not extend that link.");
}

/** Every link ends and the tunnel is replaced, so the address changes too. */
export function rotateShare(): Promise<ShareStatus> {
  return shareWrite("/rotate", {}, "Leglas could not replace the links.");
}

export async function stopShare(): Promise<void> {
  const response = await fetch("/leglas/api/share/stop", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw await refusal(response, "Leglas could not stop sharing.");
}
