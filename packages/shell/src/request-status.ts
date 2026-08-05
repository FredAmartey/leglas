export type RequestStatus = { title: string; status: "queued" | "picked-up" };

/**
 * What the composer says under the field.
 *
 * One function decides the whole line, because the inputs argue with each
 * other: a queued request outranks an attached agent, and an agent that is
 * merely listening outranks the standing instruction to go run a command.
 * Null means nothing here beats that standing instruction, which is the only
 * case the caller renders itself.
 */
export function requestStatusLine(
  requests: readonly RequestStatus[],
  activeTitle: string | null,
  attached = false,
): string | null {
  if (activeTitle === null) return null;
  const active = requests.filter((request) => request.title === activeTitle);
  const queued = active.filter((request) => request.status === "queued").length;
  if (queued > 0) return `${queued} change${queued === 1 ? "" : "s"} queued for your agent`;
  if (active.some((request) => request.status === "picked-up")) return "Your agent is on it";
  return attached ? "Your agent is listening" : null;
}
