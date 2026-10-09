import type { AgentEffort, AgentOption } from "./request-status.js";
import { readJson } from "../net/api.js";

export type AgentsPayload = {
  agents: AgentOption[];
  choice: string | null;
  customRun: string | null;
  effort: AgentEffort | null;
};

const AGENT_READ_TIMEOUT_MS = 5_000;

const AGENT_ACTION_TIMEOUT_MS = 10_000;

async function request(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readAgents(refresh = false): Promise<AgentsPayload> {
  const response = await request(
    `/leglas/api/agents${refresh ? "?refresh=1" : ""}`,
    undefined,
    AGENT_READ_TIMEOUT_MS,
  );

  if (!response.ok) throw new Error("Leglas refused the agent request.");

  return readJson<AgentsPayload>(response);
}

async function post(path: string, body: Record<string, string | null> | null): Promise<void> {
  const init: RequestInit = { method: "POST" };

  if (body !== null) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await request(path, init, AGENT_ACTION_TIMEOUT_MS);

  if (!response.ok) throw new Error("Leglas refused the agent request.");
  const result = await readJson<{ ok?: boolean }>(response);

  if (result.ok !== true) throw new Error("Leglas refused the agent request.");
}

export function chooseAgent(agent: string, run?: string): Promise<void> {
  return post("/leglas/api/agent", run === undefined ? { agent } : { agent, run });
}

export function chooseAgentEffort(agent: string, effort: AgentEffort | null): Promise<void> {
  return post("/leglas/api/agent", { agent, effort });
}

/**
 * Says a request is probably coming, so the chosen agent can warm now. Sent
 * when the composer takes focus; the server keeps nothing warm at boot and
 * releases idle agents.
 */
export function warmAgent(): Promise<void> {
  return post("/leglas/api/agents/warm", null);
}

export function cancelAgentRun(id?: string | null): Promise<void> {
  return post("/leglas/api/requests/cancel", id == null ? null : { id });
}

export function retryFailedRequest(id: string): Promise<void> {
  return post("/leglas/api/requests/retry", { id });
}

export function dismissFailedRequest(id: string): Promise<void> {
  return post("/leglas/api/requests/dismiss", { id });
}
