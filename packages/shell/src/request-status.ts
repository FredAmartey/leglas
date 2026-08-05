export type RequestStatus = { title: string; status: "queued" | "picked-up" };

export function requestStatusLine(
  requests: readonly RequestStatus[],
  activeTitle: string | null,
): string | null {
  if (activeTitle === null) return null;
  const active = requests.filter((request) => request.title === activeTitle);
  const queued = active.filter((request) => request.status === "queued").length;
  if (queued > 0) return `${queued} change${queued === 1 ? "" : "s"} queued for your agent`;
  return active.some((request) => request.status === "picked-up") ? "Your agent is on it" : null;
}
