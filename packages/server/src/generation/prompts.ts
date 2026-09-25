/**
 * The words a generation run is given.
 *
 * Every sentence here was measured before it went in: the plan prompt keeps
 * the planner from exploring, and the build prompt is what took a build from
 * 29 to 43 model calls down to 3. Change them by measuring again, not by feel.
 */

import { isJsonRecord, isString, parseJson, type JsonValue } from "../json.js";

export type Concept = { key: string; title: string; idea: string };

/** The direction a set varies, which every variation must stay recognisably. */
export type Base = { title: string; idea: string };

export type PlanInput = {
  surface: string;
  brief: string;
  count: number;
  existing: readonly string[];
  base?: Base | null;
};

export type BuildInput = {
  surface: string;
  brief: string;
  concept: Concept;
  others: readonly Concept[];
  file: string;
  name: string;
  stack: string;
  facts: string;
  base?: Base | null;
};

/** A base as prompts name it: its title, then its idea when it has one. */
function described(base: Base): string {
  const idea = base.idea.replace(/\.$/, "");

  return idea === "" ? `"${base.title}"` : `"${base.title}" (${idea})`;
}

/** What a variation set was asked to lean towards, as a sentence, when anything was typed. */
function steer(brief: string): string {
  if (brief === "") return ".";

  return `. What to explore: ${/[.!?]$/.test(brief) ? brief : `${brief}.`}`;
}

const ANSWER =
  "Answer from this brief alone: do not read, search or run anything. Reply with only a JSON array of objects with key (kebab-case), title and idea (one line).";

export function planPrompt(input: PlanInput): string {
  const { base } = input;

  // Variations have the opposite failure to a spread: drift, not sameness.
  if (base !== undefined && base !== null) {
    return `Propose ${input.count} variations of the ${input.surface} direction ${described(base)}${steer(input.brief)} Every variation stays recognisably ${base.title} and changes one deliberate thing; name each for what it changes. Decide them together so no two change the same thing. ${ANSWER}`;
  }

  const already =
    input.existing.length === 0
      ? ""
      : ` The ${input.surface} already has these directions: ${input.existing.join(", ")}; yours must differ from them too.`;

  return `Propose ${input.count} genuinely different design directions for the ${input.surface} of this product: ${input.brief} Decide all of them together; if two would look alike at a glance, replace one.${already} ${ANSWER}`;
}

/** One new concept for a slot being replaced: unlike the one it replaces and unlike every other. */
export function replacePrompt(input: {
  surface: string;
  brief: string;
  avoid: readonly Concept[];
  base?: Base | null;
}): string {
  const avoid = input.avoid.map((concept) => `${concept.title} (${concept.idea})`).join("; ");
  const { base } = input;

  if (base !== undefined && base !== null) {
    return `Propose 1 more variation of the ${input.surface} direction ${described(base)}${steer(input.brief)} It stays recognisably ${base.title} and changes something none of these change: ${avoid}. ${ANSWER}`;
  }

  return `Propose 1 design direction for the ${input.surface} of this product: ${input.brief} It must not look like any of these: ${avoid}. ${ANSWER}`;
}

export function buildPrompt(input: BuildInput): string {
  const others = input.others.map((other) => `${other.title} (${other.idea})`).join("; ");

  const { base } = input;
  const varying = base !== undefined && base !== null;

  const rivals =
    others === ""
      ? ""
      : varying
        ? ` The other variations are ${others}; change something different from them.`
        : ` The other directions are ${others}; yours must not look like any of them.`;

  const what = varying
    ? `Build this variation of the ${input.surface} direction "${base.title}": ${input.concept.title}, ${input.concept.idea.replace(/\.$/, "")}. Keep it recognisably ${base.title} and change only what the variation names.`
    : `Build this design direction for the ${input.surface}: ${input.concept.title}, ${input.concept.idea.replace(/\.$/, "")}.`;

  const product = varying ? steer(input.brief).slice(1) : ` The product: ${input.brief}`;

  return `${what}${product}${rivals}

Everything you need is in this message, so do not look around the project. It is ${input.stack}. Your file is ${input.file}. It holds a placeholder: read it once, then replace it in a single write with a component exported as ${input.name}. Keep every new style in that file, in a <style> element or inline.

${input.facts}

This is a first draft for someone comparing directions side by side, not a finished page. Aim for about 250 lines and write it in one pass: no second drafts, and no review, lint, tests or screenshots. Leglas renders and captures it for you. Your task ends when the file is written.`;
}

/** The one follow-up a build gets when its page fails to render. */
export function fixPrompt(input: { file: string; errors: readonly string[] }): string {
  return `Leglas rendered ${input.file} and the page reported: ${input.errors.slice(0, 3).join(" | ")}. Fix what your file causes, in as few edits as you can, and change nothing else. If nothing in your file causes it, change nothing. Do not look around the project.`;
}

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function pascal(key: string): string {
  return key
    .split("-")
    .filter((part) => part !== "")
    .map((part) => (/^\d/.test(part) ? `N${part}` : part[0]!.toUpperCase() + part.slice(1)))
    .join("");
}

/**
 * The concepts in a plan reply, fenced or bare: exactly `count` of them, each
 * with a distinct kebab-case key. A reply that cannot give that many is an
 * error, not a smaller set, so the rail never shows fewer than were asked for
 * without saying why.
 */
export function parseConcepts(reply: string, count: number): Concept[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");

  if (start === -1 || end < start) throw new Error("The plan reply held no JSON array.");
  let parsed: JsonValue;

  try {
    parsed = parseJson(reply.slice(start, end + 1));
  } catch {
    throw new Error("The plan reply's JSON did not parse.");
  }

  if (!Array.isArray(parsed)) throw new Error("The plan reply held no JSON array.");
  const concepts: Concept[] = [];

  for (const entry of parsed) {
    if (!isJsonRecord(entry)) continue;
    const title = isString(entry.title) ? entry.title.trim() : "";
    const key = kebab(isString(entry.key) && entry.key.trim() !== "" ? entry.key : title);

    if (title === "" || key === "" || concepts.some((concept) => concept.key === key)) continue;
    concepts.push({ key, title, idea: isString(entry.idea) ? entry.idea.trim() : "" });

    if (concepts.length === count) return concepts;
  }

  throw new Error(`The plan reply named fewer than ${count} distinct directions.`);
}
