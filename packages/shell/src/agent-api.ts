import type { AgentEffort, AgentOption } from "./request-status.js";

export type AgentFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type AgentsPayload = {
  agents: AgentOption[];
  choice: string | null;
  customRun: string | null;
  effort: AgentEffort | null;
};

const browserFetch: AgentFetcher = (input, init) => fetch(input, init);
const AGENT_READ_TIMEOUT_MS = 5_000;
const AGENT_ACTION_TIMEOUT_MS = 10_000;

async function request(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetcher: AgentFetcher,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readAgents(
  refresh = false,
  fetcher: AgentFetcher = browserFetch,
): Promise<AgentsPayload> {
  const response = await request(
    `/leglas/api/agents${refresh ? "?refresh=1" : ""}`,
    undefined,
    AGENT_READ_TIMEOUT_MS,
    fetcher,
  );
  if (!response.ok) throw new Error("Leglas refused the agent request.");
  return response.json() as Promise<AgentsPayload>;
}

async function post(
  path: string,
  body: Record<string, string | null> | null,
  fetcher: AgentFetcher,
): Promise<void> {
  const response = await request(
    path,
    {
      method: "POST",
      ...(body === null
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    AGENT_ACTION_TIMEOUT_MS,
    fetcher,
  );
  if (!response.ok) throw new Error("Leglas refused the agent request.");
  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) throw new Error("Leglas refused the agent request.");
}

export function chooseAgent(
  agent: string,
  run?: string,
  fetcher: AgentFetcher = browserFetch,
): Promise<void> {
  return post("/leglas/api/agent", run === undefined ? { agent } : { agent, run }, fetcher);
}

export function chooseAgentEffort(
  agent: string,
  effort: AgentEffort | null,
  fetcher: AgentFetcher = browserFetch,
): Promise<void> {
  return post("/leglas/api/agent", { agent, effort }, fetcher);
}

export function cancelAgentRun(
  id?: string | null,
  fetcher: AgentFetcher = browserFetch,
): Promise<void> {
  return post("/leglas/api/requests/cancel", id == null ? null : { id }, fetcher);
}

export function retryFailedRequest(
  id: string,
  fetcher: AgentFetcher = browserFetch,
): Promise<void> {
  return post("/leglas/api/requests/retry", { id }, fetcher);
}

export function dismissFailedRequest(
  id: string,
  fetcher: AgentFetcher = browserFetch,
): Promise<void> {
  return post("/leglas/api/requests/dismiss", { id }, fetcher);
}
