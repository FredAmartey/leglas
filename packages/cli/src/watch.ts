import type { PendingRequest } from "@leglas/server";

/** Where the agent command is remembered, beside the other machine-local state. */
export const WATCH_PATH = ".leglas/watch.json";

/** The one thing the template must contain, and the only thing substituted. */
export const PROMPT_TOKEN = "{prompt}";

const EXAMPLE = `leglas watch --run "claude -p ${PROMPT_TOKEN}"`;

export type WatchTemplate = {
  command: string;
  /** Still holds the placeholder; commandFor substitutes per request. */
  args: readonly string[];
};

export type TemplateResult = { ok: true; template: WatchTemplate } | { ok: false; error: string };

/**
 * Split the template the way a shell would, without a shell.
 *
 * The tokens are handed straight to spawn, so nothing here expands, globs or
 * substitutes: a prompt is arbitrary text a browser typed, and letting a shell
 * see it is an injection with the user's own credentials attached. Quotes are
 * supported because an agent command routinely carries a flag value with a
 * space in it, and that is the only reason.
 */
function tokenize(template: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
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
 * Validate an agent command before anything is spawned or remembered.
 *
 * Every refusal is one line naming the fix, because this is the first thing a
 * user types and the failure is always the same shape: the placeholder is
 * missing, or it is glued to something else. Substituting a placeholder that
 * is part of a larger token would build an argument the agent never asked for,
 * so that case is refused rather than guessed at.
 */
export function parseTemplate(raw: string): TemplateResult {
  const tokenized = tokenize(raw);
  if (!tokenized.ok) return tokenized;

  const { tokens } = tokenized;
  const [command, ...args] = tokens;
  if (command === undefined) {
    return { ok: false, error: `Watch needs an agent command, for example: ${EXAMPLE}` };
  }

  const placeholders = tokens.filter((token) => token === PROMPT_TOKEN).length;
  if (placeholders === 0) {
    return {
      ok: false,
      error: `The agent command needs ${PROMPT_TOKEN} as a word of its own, for example: ${EXAMPLE}`,
    };
  }
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
 * The argv for one request. The prompt is a single entry however many words,
 * lines or quotes it contains, which is the whole reason the template names a
 * placeholder instead of being pasted together as a string.
 */
export function commandFor(
  template: WatchTemplate,
  prompt: string,
): { command: string; args: string[] } {
  return {
    command: template.command,
    args: template.args.map((argument) => (argument === PROMPT_TOKEN ? prompt : argument)),
  };
}

/**
 * The request to hand over next, or nothing to do.
 *
 * Queue order, one at a time: two agents editing one tree at once produce a
 * conflict the user has to untangle. Ids that already failed are skipped for
 * the life of the process, since a prompt that broke the agent will break it
 * again and retrying it is the user's tokens on fire.
 */
export function nextRequest(
  requests: readonly PendingRequest[],
  failed: ReadonlySet<string>,
): PendingRequest | null {
  return (
    requests.find((request) => request.status === "queued" && !failed.has(request.id)) ?? null
  );
}
