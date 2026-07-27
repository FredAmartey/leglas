import { surfaceSlug } from "./new.js";

export type Brief = {
  slug: string;
  name: string;
  brief: string;
  /**
   * Named because agents converge without it: the obvious reading of any angle
   * is a small tweak to what already exists.
   */
  avoid: string;
};

/**
 * Angles for exploring a surface.
 *
 * Left to itself an agent iterates narrowly around its first idea, so six
 * requests return six shades of one design. These exist to force real
 * divergence, and each varies several properties at once rather than turning a
 * single knob: composition, medium, density, motion, texture and palette
 * rather than colour alone.
 *
 * Ordered for spread, so asking for three still explores widely instead of
 * returning three neighbours.
 */
export const ALL_BRIEFS: Brief[] = [
  {
    slug: "quiet",
    name: "Quiet",
    brief:
      "Reduce until almost nothing is left. Generous whitespace, a single focal element, and typography carrying the whole hierarchy. Remove decoration rather than softening it.",
    avoid: "Adding a subtle gradient or a lighter shade and calling the result minimal.",
  },
  {
    slug: "image-led",
    name: "Image-led",
    brief:
      "Let imagery be the page. Full-bleed visual, text as a restrained overlay, and a composition that follows the artwork rather than sitting beside it.",
    avoid: "Keeping the existing layout and enlarging the picture inside it.",
  },
  {
    slug: "kinetic",
    name: "Kinetic",
    brief:
      "Motion carries the hierarchy. Something continuous and ambient, with elements arriving in a deliberate sequence. Honour prefers-reduced-motion with a still composition that still works.",
    avoid: "A fade-in on scroll bolted onto the current design.",
  },
  {
    slug: "editorial",
    name: "Editorial",
    brief:
      "Compose it like a magazine spread. Asymmetric grid, large display type with tight leading, rules and captions, imagery treated as a plate rather than a background.",
    avoid: "A centred headline above a centred paragraph.",
  },
  {
    slug: "dense",
    name: "Dense",
    brief:
      "Information forward. Tighter rhythm, smaller type, several entry points visible at once, and the confidence that the reader wants more rather than less.",
    avoid: "The same layout with the padding reduced.",
  },
  {
    slug: "high-contrast",
    name: "High contrast",
    brief:
      "Commit to a hard palette: near-black against one saturated accent, or the whole thing inverted. Define shapes with edges rather than gradients.",
    avoid: "Darkening the existing palette by a few steps.",
  },
  {
    slug: "material",
    name: "Material",
    brief:
      "Give it depth and surface. Layered planes, grain or noise, shadow used structurally to stack elements, a sense that the parts are physical objects.",
    avoid: "One drop shadow on an otherwise flat card.",
  },
  {
    slug: "type-led",
    name: "Type-led",
    brief:
      "Remove imagery entirely. Build the composition from letterforms: extreme scale contrast, a second typeface earning its place, text as the visual itself.",
    avoid: "Keeping the image and setting the headline larger.",
  },
  {
    slug: "playful",
    name: "Playful",
    brief:
      "Deliberate imperfection. Rotation, overlap, irregular or hand-made elements, and one colour that ought not to work but does.",
    avoid: "Increasing the border radius and little else.",
  },
  {
    slug: "systemic",
    name: "Systemic",
    brief:
      "Make the structure visible. Modular blocks on a stated grid, consistent module sizes, alignment itself as the aesthetic.",
    avoid: "Adding borders around the sections that already exist.",
  },
];

export function briefsFor(count: number): Brief[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  return ALL_BRIEFS.slice(0, Math.min(Math.floor(count), ALL_BRIEFS.length));
}

export function planBriefs(
  surface: string,
  count: number,
): { previews: { title: string; url: string }[]; commands: string[]; instructions: string } {
  const slug = surfaceSlug(surface);
  const chosen = briefsFor(count);

  const previews = chosen.map((brief) => ({
    title: brief.name,
    url: `/?v-${slug}=${brief.slug}`,
  }));

  const commands = chosen.map(
    (brief) =>
      `leglas add --title ${JSON.stringify(brief.name)} --url ${JSON.stringify(
        `/?v-${slug}=${brief.slug}`,
      )} --note ${JSON.stringify(`${brief.brief.split(".")[0]}.`)}`,
  );

  const instructions =
    `Build ${chosen.length} direction${chosen.length === 1 ? "" : "s"} for "${surface}", one per angle below.\n\n` +
    `Each goes in its own file under .leglas/variants/${slug}/, named after its ` +
    `slug, and is listed in the DIRECTIONS map in that folder's switch file. If ` +
    `the surface has no switch file yet, run \`leglas new ${slug}\` first.\n\n` +
    `Keep them distinct from each other. The point of exploring several at once ` +
    `is that they disagree; directions that converge on one look waste the ` +
    `exercise. Read each angle's "avoid" line before starting, because it names ` +
    `the obvious reading that collapses the difference.\n\n` +
    `Then register them:\n\n` +
    commands.map((command) => `  ${command}`).join("\n");

  return { previews, commands, instructions };
}
