import type { ShareRequest } from "./share.js";
import type { ShareStatus, TunnelProviderId } from "./types.js";

/**
 * The share endpoints, as the panel calls them. Every refusal comes back as
 * an Error carrying the server's own sentence, which is the one worth
 * putting on screen: "Branch directions can't be shared yet" says what to do,
 * a status code does not.
 */
export type SharePayload = {
  share: ShareStatus | null;
  /** Tunnel programs found on this machine, in the order Leglas would pick. */
  tunnels: TunnelProviderId[];
};

async function refusal(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof payload?.error === "string" ? payload.error : fallback);
}

export async function readShare(signal?: AbortSignal): Promise<SharePayload> {
  const response = await fetch("/leglas/api/share", signal === undefined ? {} : { signal });
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  return response.json() as Promise<SharePayload>;
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
  const payload = (await response.json()) as { share: ShareStatus };
  return payload.share;
}

export async function updateShare(body: ShareRequest): Promise<ShareStatus> {
  const response = await fetch("/leglas/api/share/update", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await refusal(response, "Leglas could not update the share.");
  const payload = (await response.json()) as { share: ShareStatus };
  return payload.share;
}

async function shareWrite(path: string, body: unknown, fallback: string): Promise<ShareStatus> {
  const response = await fetch(`/leglas/api/share${path}`, {
    body: JSON.stringify(body ?? {}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await refusal(response, fallback);
  const payload = (await response.json()) as { share: ShareStatus };
  return payload.share;
}

/** Let a path through that a listed share turned away. */
export function allowRoute(path: string): Promise<ShareStatus> {
  return shareWrite("/allow", { path }, "Leglas could not allow that path.");
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
