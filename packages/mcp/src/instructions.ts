import { CHANNEL_INSTRUCTIONS } from "./channel.js";

/**
 * The workflow, for hosts that load no skill. Claude Code keeps the first 2048
 * characters, so the steps that matter most come first.
 */
export const SERVER_INSTRUCTIONS = [
  "Leglas compares design directions inside the user's running app. Each direction is a URL " +
    "of their dev server; the interface lists them in a rail and puts one, or two side by side, " +
    "on the stage.",
  "To build directions, call `start` first and give the user its url: the rail fills in as you " +
    "register. `explore` briefs the set, and `classify` says whether a direction can live in the " +
    "running app or needs its own branch. `scaffold` writes a switcher for a surface. Add each " +
    "direction beside what exists, never rewriting a file another direction renders, and register " +
    "it with `add` the moment it renders. Then call `show` with screenshot true and fix anything " +
    "that looks broken. When one is ready, hand the user the interfaceUrl from `add` or `show`, or " +
    "a `link` that puts two side by side.",
  "Before changing a direction, call `requests`: the user may have asked from the interface. " +
    "`keep` moves the winner into real source and deletes the rest of the exploration. `list` " +
    "shows every direction, `share` shows them to someone without the project, and `init` sets a " +
    "project up: its AGENTS.md section, a starter config and a gitignore entry.",
  CHANNEL_INSTRUCTIONS,
].join("\n\n");
