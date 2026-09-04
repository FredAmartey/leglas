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

export async function stopShare(): Promise<void> {
  const response = await fetch("/leglas/api/share/stop", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await refusal(response, "Leglas could not stop sharing.");
}
