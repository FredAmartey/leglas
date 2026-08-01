import { ignoreEntry } from "./ignore.js";
import type { Write } from "./new.js";

export const AGENTS_MARKER_START = "<!-- leglas:start -->";
export const AGENTS_MARKER_END = "<!-- leglas:end -->";

export type InitPlan = { writes: Write[]; gitignore: string | null };

/**
 * What an agent entering this repository needs to know.
 *
 * The instruction that matters is additive authoring. Asked to make a hero
 * calmer, an agent's instinct is to edit the hero, and two directions that
 * both rewrite the same file cannot coexist in one running server. That would
 * quietly cost the property the whole tool is built on, and nothing in the
 * runtime can prevent it, because Leglas never sees the app's source. So it
 * has to be said here, plainly, before anything else.
 */
const AGENTS_SECTION = `${AGENTS_MARKER_START}

## Design directions (Leglas)

This project uses Leglas to compare design directions inside the running app.
A direction is just a URL; the app decides what it renders, and Leglas only
displays it.

This is small, additive work: a few self-contained files and a command per
direction. Build it directly. A planning or approval step before implementing
costs more than the work itself, and the directions on screen are the thing
being asked for.

When asked for design variations, alternatives, or "a few options":

1. **Add beside what exists. Never replace it.** Every direction has to render
   from the one dev server that is already running, which is what makes
   switching between them instant. Two directions that rewrite the same file
   cannot both exist, and recovering from that costs a rebuild per direction.
   If a direction cannot be additive, because it must change dependencies,
   change build configuration, or rewrite an existing file's behaviour, ask
   where it should live before writing it:
   \`leglas classify --change package.json --rewrite src/theme.css --json\`.
   When the answer is \`checkout\`, build the direction on its own git branch
   and register it with \`leglas add --title "…" --url "/" --branch <branch>\`
   (the config needs \`devCommand\` with \`{port}\`). Everything below is the
   ordinary, in-app path.
2. Run \`leglas explore <surface> --count <n>\` first. It returns distinct
   angles to build, each with what to avoid, so several directions genuinely
   disagree instead of becoming shades of one idea. Follow those angles rather
   than inventing your own variations of the current design.
3. If the surface has no switcher yet, run
   \`leglas new <surface> --from <the component that renders it today>\`. It
   writes one under \`.leglas/variants/<surface>/\` and prints the single line
   to add where that surface renders. \`--from\` makes the baseline re-export
   the real component rather than copying it, so it stays live.
4. Put each direction in its own file beside the others in
   \`.leglas/variants/<surface>/\`, then list it in the \`DIRECTIONS\` map in
   that folder's \`switch\` file.
5. Register each one so it appears in the interface:
   \`leglas add --title "Aurora" --url "/?v-<surface>=aurora" --note "One line on the idea."\`
6. Tell the user to open the interface, or to run \`leglas\` if it is not
   already running.

When the user asks to change one direction, check \`leglas requests --json\`
first: they may have described it from the interface, and the request names the
exact file. Clear the queue with \`leglas requests --clear\` once done.

When the user picks a winner, run
\`leglas keep "<title>" --to <path in real source>\`. It moves that direction
out of the ignored directory, deletes the rest of the exploration, and drops
them from the rail. Then change their component to use the kept component
instead of the switcher.

Useful to know:

- \`.leglas/\` is gitignored. Exploration is disposable and nothing in there
  ships. Move a direction into real source only when it wins.
- If the project has no running app yet, a direction can be a plain HTML
  file: write it under \`.leglas/pages/\` and register it with
  \`leglas add --title "Aurora" --file .leglas/pages/aurora.html\`. Leglas
  serves the file itself, so no dev server is needed. Sibling assets in the
  same directory resolve normally.
- Titles identify previews and must be unique.
- \`leglas list\` shows every direction, shared and local.
- Every command accepts \`--json\` and prints one envelope with a stable exit
  code, so you can drive it without parsing prose.

${AGENTS_MARKER_END}
`;

const STARTER_CONFIG = `// Previews are URLs of your own app. Add one per direction you want to
// compare, then run \`leglas\`.
export default {
  // Where your dev server is. Override at the command line with --user-port.
  devServer: "http://localhost:3000",
  previews: [{ title: "Current", url: "/" }],
};
`;

export function planInit(options: {
  agents: string | null;
  config: string | null;
  gitignore: string | null;
  force?: boolean;
}): InitPlan {
  const writes: Write[] = [];
  const agents = options.agents ?? "";
  const hasSection = agents.includes(AGENTS_MARKER_START);

  if (!hasSection) {
    const preamble = agents.replace(/\n*$/, "");
    writes.push({
      path: "AGENTS.md",
      contents: preamble === "" ? AGENTS_SECTION : `${preamble}\n\n${AGENTS_SECTION}`,
    });
  } else if (options.force === true) {
    // Replace between the markers so a project's own instructions survive an
    // update to ours.
    const start = agents.indexOf(AGENTS_MARKER_START);
    const end = agents.indexOf(AGENTS_MARKER_END);
    const after = end === -1 ? "" : agents.slice(end + AGENTS_MARKER_END.length);
    writes.push({
      path: "AGENTS.md",
      contents: `${agents.slice(0, start)}${AGENTS_SECTION.replace(/\n$/, "")}${after}`,
    });
  }

  // A config is the user's description of their own project, so it is created
  // when absent and never edited when present.
  if (options.config === null) {
    writes.push({ path: "leglas.config.ts", contents: STARTER_CONFIG });
  }

  return { writes, gitignore: ignoreEntry(options.gitignore) };
}
