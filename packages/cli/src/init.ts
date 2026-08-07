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
   \`npx leglas classify --change package.json --rewrite src/theme.css --json\`.
   When the answer is \`checkout\`, build the direction on its own git branch
   and register it with \`npx leglas add --title "…" --url "/" --branch <branch>\`
   (the config needs \`devCommand\` with \`{port}\`). Everything below is the
   ordinary, in-app path.
2. Run \`npx leglas explore <surface> --count <n>\` first, adding
   \`--based-on "<title>"\` when the user wants variations of a direction they
   already like. It prints what the set needs and how to register it. In
   short: new directions must genuinely disagree with each other, variants of
   one must not, and either way decide the whole set before building any of
   it. The designs themselves are yours.
3. If the surface has no switcher yet, run
   \`npx leglas new <surface> --from <the component that renders it today>\`. It
   writes one under \`.leglas/variants/<surface>/\` and prints the single line
   to add where that surface renders. \`--from\` makes the baseline re-export
   the real component rather than copying it, so it stays live.
4. Before building, make sure the interface is up. If Leglas is not
   already running, tell the user to run \`npx leglas\`, and hand them the
   URL now rather than when the set is done: the rail picks up each
   registration within seconds, so they get to watch the exploration fill in.
5. Build one direction at a time: its own file beside the others in
   \`.leglas/variants/<surface>/\`, listed in the \`DIRECTIONS\` map in that
   folder's \`switch\` file, then registered the moment it renders:
   \`npx leglas add --title "Aurora" --url "/?v-<surface>=aurora" --note "One line on the idea."\`
   Register each direction as it lands, never the whole set at the end. To
   the user watching the rail, a batch at the end is minutes of nothing and
   then everything at once.

When the user asks to change one direction, check \`npx leglas requests --json\`
first: they may have described it from the interface, and the request names the
exact file. Acknowledge them with \`npx leglas requests --clear\` once done: it
drops what you collected and reports anything the user typed while you worked,
which is yours to collect and do next.

If the user wants requests handled the moment they are typed, without relaying
each one, tell them about \`npx leglas watch --run "claude -p {prompt}"\` (any
agent command works; {prompt} receives the request). It runs in their
terminal, hands each request to that command as it arrives, and the interface
shows the request's progress.

When the user picks a winner, run
\`npx leglas keep "<title>" --to <path in real source>\`. It moves that direction
out of the ignored directory, deletes the rest of the exploration, and drops
them from the rail. Then change their component to use the kept component
instead of the switcher.

Useful to know:

- \`.leglas/\` is gitignored. Exploration is disposable and nothing in there
  ships. Move a direction into real source only when it wins.
- If the project has no running app yet, a direction can be a plain HTML
  file: write it under \`.leglas/pages/\` and register it with
  \`npx leglas add --title "Aurora" --file .leglas/pages/aurora.html\`. Leglas
  serves the file itself, so no dev server is needed. Sibling assets in the
  same directory resolve normally.
- Titles identify previews and must be unique. The user may rename one in the
  rail, which renames it on their machine only; the commands answer to either
  name, so use whichever they said.
- \`npx leglas list\` shows every direction, shared and local.
- \`npx leglas show "<title>" --json\` answers for one of them: the file behind it,
  the variants based on it, what it is being compared against, and anything
  they have asked for that is not done yet. Run it when handed a direction you
  did not register yourself.
- Every command accepts \`--json\` and prints one envelope with a stable exit
  code, so you can drive it without parsing prose.

${AGENTS_MARKER_END}
`;

const STARTER_CONFIG = `// Previews are URLs of your own app. Add one per direction you want to
// compare, then run \`npx leglas\`.
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
