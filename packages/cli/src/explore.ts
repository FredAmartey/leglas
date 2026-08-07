import { surfaceSlug } from "./new.js";

/**
 * What leglas explore hands an agent.
 *
 * It used to hand out ten prewritten angles, each with an avoid line. Retired
 * deliberately: prewritten taste is generic where the agent's is contextual,
 * and every project drawing on one deck converges across projects, which is
 * the failure this command exists to fight, one level up. What survives is
 * what the agent cannot supply itself: the mechanics of registering a set
 * here, the purpose that makes the set worth building, and the one trap each
 * kind of set has been seen to fall into. Which designs to build, and what
 * counts as different, belong to the agent that knows the product.
 *
 * Two kinds of set, opposite goals. Directions exist to be chosen between, so
 * they only work if they genuinely disagree. Variants pick within a direction
 * already chosen, so they only work if they do not.
 */
export type ExplorePlan = {
  surface: string;
  slug: string;
  count: number;
  /** The direction being varied, or null when exploring for spread. */
  basedOn: string | null;
  instructions: string;
};

export function planExplore(surface: string, count: number, basedOn: string | null = null): ExplorePlan {
  const slug = surfaceSlug(surface);

  const goal =
    basedOn === null
      ? `Build ${count} design directions for "${surface}".\n\n` +
        `The set exists to be chosen from, and the choice only means something ` +
        `if the directions genuinely disagree: ${count} variants of one idea would ` +
        `make it empty. What counts as different is yours to decide, and the ` +
        `strongest sets disagree about more than styling.\n\n` +
        `One trap, seen every time this goes wrong: a set collapses toward ` +
        `whichever direction is built first. Decide all ${count} before building ` +
        `any, and if two would read as the same direction at a glance, replace ` +
        `one of them.`
      : `Build ${count} variations of the "${basedOn}" direction for "${surface}".\n\n` +
        `The set exists to pick a variant of a direction already chosen, so every ` +
        `variation must stay recognisably that direction. The trap here is ` +
        `drift: change enough and the comparison stops being about the variant. ` +
        `Vary each one deliberately and hold everything else still; if a ` +
        `variation grows into a new direction, it belongs in its own ` +
        `exploration instead.`;

  const register =
    basedOn === null
      ? `  npx leglas add --title "<name>" --url "/?v-${slug}=<key>" --note "<the idea, one line>"`
      : `  npx leglas add --title "<name>" --url "/?v-${slug}=<key>" --based-on ${JSON.stringify(basedOn)} --note "<the idea, one line>"`;

  const mechanics =
    `Each one is its own file under .leglas/variants/${slug}/, listed in the ` +
    `DIRECTIONS map in that folder's switch file. If there is no switch file ` +
    `yet, run \`npx leglas new ${slug}\` first. Register each one the moment it ` +
    `renders, not the set at the end. The interface picks a registration up ` +
    `within seconds, so whoever asked watches the set fill in:\n\n` +
    `${register}\n\n` +
    `The title and note are what the user judges from in the rail, so name ` +
    `each one for its idea rather than numbering it.`;

  return { surface, slug, count, basedOn, instructions: `${goal}\n\n${mechanics}` };
}
