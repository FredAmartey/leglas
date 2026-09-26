import type { PendingRequest } from "../requests/requests.js";

/** Where the agent command is remembered, beside the other machine-local state. */
export const WATCH_PATH = ".leglas/watch.json";

/** The one thing the template must contain, and the only thing substituted. */
export const PROMPT_TOKEN = "{prompt}";

const EXAMPLE = `npx leglas watch --run "claude -p ${PROMPT_TOKEN}"`;

export type WatchTemplate = {
  command: string;
  /** Still holds the placeholder; commandFor substitutes per request. */
  args: readonly string[];
};

export type TemplateResult = { ok: true; template: WatchTemplate } | { ok: false; error: string };

/**
 * Splits the template the way a shell would, without a shell. Tokens go
 * straight to spawn and nothing expands or globs, since a prompt is arbitrary
 * browser text; quotes are supported only for flag values with spaces.
 */
export function tokenize(
  template: string,
): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const character of template) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }

    current += character;
    started = true;
  }

  if (quote !== null) {
    return { ok: false, error: `The agent command has an unclosed ${quote} quote.` };
  }

  if (started) tokens.push(current);

  return { ok: true, tokens };
}

/**
 * Validates an agent command before anything is spawned or saved. Without a
 * placeholder the request goes last, where nearly every agent CLI takes its
 * prompt; ${PROMPT_TOKEN} is for the rest. A placeholder glued to another word
 * is refused, since that's always a typo.
 */
export function parseTemplate(raw: string): TemplateResult {
  const tokenized = tokenize(raw);

  if (!tokenized.ok) return tokenized;

  const { tokens } = tokenized;
  const [command, ...args] = tokens;

  if (command === undefined) {
    return { ok: false, error: `Watch needs an agent command, for example: ${EXAMPLE}` };
  }

  if (tokens.some((token) => token !== PROMPT_TOKEN && token.includes(PROMPT_TOKEN))) {
    return {
      ok: false,
      error: `${PROMPT_TOKEN} must stand as a word of its own, for example: ${EXAMPLE}`,
    };
  }

  const placeholders = tokens.filter((token) => token === PROMPT_TOKEN).length;

  if (placeholders > 1) {
    return {
      ok: false,
      error: `The agent command takes ${PROMPT_TOKEN} once, for example: ${EXAMPLE}`,
    };
  }

  if (command === PROMPT_TOKEN) {
    return {
      ok: false,
      error: `The agent command must name a program before ${PROMPT_TOKEN}, for example: ${EXAMPLE}`,
    };
  }

  return { ok: true, template: { command, args } };
}

/**
 * The argv for one request. The prompt is one entry whatever it contains, which
 * is why nothing is joined into a string. Without a placeholder it goes last.
 */
export function commandFor(template: WatchTemplate, prompt: string) {
  if (!template.args.includes(PROMPT_TOKEN)) {
    return { command: template.command, args: [...template.args, prompt] };
  }

  return {
    command: template.command,
    args: template.args.map((argument) => (argument === PROMPT_TOKEN ? prompt : argument)),
  };
}

/**
 * The next request to hand over, in queue order and one at a time so two agents
 * never edit one tree. Ids that failed are skipped for the process's life: the
 * same prompt breaks the agent the same way, at the user's cost.
 */
export function nextRequest(
  requests: readonly PendingRequest[],
  failed: ReadonlySet<string>,
): PendingRequest | null {
  return requests.find((request) => request.status === "queued" && !failed.has(request.id)) ?? null;
}
