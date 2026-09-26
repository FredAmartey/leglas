import { DEFAULT_PORT, MAX_DIRECTIONS } from "@leglas/server";

import {
  DEFAULT_EXPLORE_COUNT,
  DEFAULT_SHARE_REACH,
  MAX_SHOW_WIDTH,
  MIN_SHOW_WIDTH,
} from "./rules.js";

/** The whole of `leglas --help`, and of `leglas <command> --help`. */
export const HELP = `leglas - compare design directions inside your own running app

Usage
  leglas init                Prepare a project and teach its agents
  leglas [options]           Start the server and open the interface
  leglas new <surface>       Scaffold a branch point for a surface
  leglas explore <surface>   Brief an agent's exploration of a surface, or build it
  leglas classify            Decide where a direction should live
  leglas add --title T --url U   Register a preview on this machine
  leglas list                Show every preview, shared and local
  leglas log [entry]         What past explorations decided
  leglas show <title>        Everything Leglas knows about one direction
  leglas share [title] [title]  Share the rail, one direction or a pair
  leglas link [title] [title]   A link that opens the interface on them
  leglas requests            Show change requests made from the interface
  leglas watch --run "<cmd>" Hand each request to your agent as it arrives
  leglas keep <title> --to <path>  Keep a winner and end the exploration

Options
  --user-port <port>   Port your dev server is on (default: from config, or 3000)
  --port <port>        Port for Leglas itself (default: ${DEFAULT_PORT}, next free if taken)
  --config <path>      Config file to use instead of searching upward
  --no-open            Do not open the browser
  --json               Print a single machine-readable envelope
  -h, --help           Show this
  -v, --version        Show the version

Options for init
  --force              Rewrite the AGENTS.md section if it is already there

Options for new
  --print              Print the scaffold instead of writing it
  --from <path>        Use an existing component as the baseline

Options for explore
  --count <n>          How many directions (default ${DEFAULT_EXPLORE_COUNT}; up to ${MAX_DIRECTIONS} with --build)
  --based-on <title>     Variants of an existing direction instead of new ones
  --build              Build the set with your agent (Claude or Codex) in the
                       running Leglas, instead of printing a brief for an agent
  --brief <text>       What the directions are for (needs --build; optional
                       with --based-on)
  --port <port>        Running Leglas port (needs --build)

Options for requests
  --clear              Acknowledge the requests once they are done

Options for watch
  --run <command>      Your agent, with {prompt} where the request goes, for
                       example "claude -p {prompt}". Remembered after first use
  --port <port>        Port Leglas itself is on (default: ${DEFAULT_PORT})
  --json               One JSON line per event; the agent's output goes to stderr

Options for classify
  --change <path>      A file the direction creates or wires up (repeatable)
  --rewrite <path>     An existing file whose behaviour it must change (repeatable)

Options for add
  --note <text>        Second line under the title
  --tag <text>         Repeatable
  --branch <name>      Back the preview with a checkout of this git branch
  --file <path>        Preview a plain HTML file served by Leglas itself
  --based-on <title>   The direction this is a variant of; groups the family
  --asked-for <text>   The change that was asked for, in the words that were typed

Options for show
  --screenshot         Render the direction and write a PNG
  --width <n>          Capture width from ${MIN_SHOW_WIDTH} to ${MAX_SHOW_WIDTH} (needs --screenshot)
  --port <port>        Running Leglas port (needs --screenshot)

Options for share
  --reach <open|listed>  How far viewers reach into the app (default ${DEFAULT_SHARE_REACH})
  --tunnel <name>      cloudflared, ngrok or none (default: the first found)
  --stop               End the share, and every link to it
  --port <port>        Running Leglas port

Options for link
  --port <port>        Running Leglas port
`;
