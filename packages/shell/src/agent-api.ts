import type { AgentOption } from "./request-status.js";

export type AgentFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type AgentsPayload = {
  agents: AgentOption[];
  choice: string | null;
  customRun: string | null;
};

const browserFetch: AgentFetcher = (input, init) => fetch(input, init);

export async function readAgents(fetcher: AgentFetcher = browserFetch): Promise<AgentsPayload> {
  const response = await fetcher("/leglas/api/agents");
  if (!response.ok) throw new Error("Leglas refused the agent request.");
  return response.json() as Promise<AgentsPayload>;
}

async function post(
  path: string,
  body: Record<string, string> | null,
  fetcher: AgentFetcher,
): Promise<void> {
  const response = await fetcher(path, {
    method: "POST",
    ...(body === null
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error("Leglas refused the agent request.");
  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) throw new Error("Leglas refused the agent request.");
}

export function chooseAgent(agent: string, fetcher: AgentFetcher = browserFetch): Promise<void> {
  return post("/leglas/api/agent", { agent }, fetcher);
}

export function cancelAgentRun(fetcher: AgentFetcher = browserFetch): Promise<void> {
  return post("/leglas/api/requests/cancel", null, fetcher);
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
