# Command line

```text
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
leglas remove <title>...   Take directions this machine registered off the rail
leglas requests            Show change requests made from the interface
leglas watch --run "<cmd>" Hand each request to your agent as it arrives
leglas keep <title> --to <path>  Keep a winner and end the exploration
```

`--json` on any command prints a single machine-readable envelope, except
`watch`, which runs until it is stopped and prints one JSON line per event
(below). `--port` chooses Leglas's own port and `--user-port` your dev server's;
`--config` names a config file instead of searching upward. Every
command's options are under `leglas <command> --help`.

What each command is for, from an agent's side, is in
[Working with agents](agents.md#what-an-agent-runs).

## Watch as JSON

`leglas watch --json` prints one JSON object per line as things happen, each
with an `event`:

| `event` | When | Other fields |
| --- | --- | --- |
| `watching` | The loop has started | `command`, what each request runs; `agent`, the agent picked in the interface or `null` |
| `started` | A request was handed to the agent | `id`, `title`, `intent`, `target` |
| `done` | The agent exited 0 and the request left the queue | `id`, `title` |
| `failed` | The agent failed; the request stays in the queue and is not retried | `id`, `title`, `code`, `reason` |
| `error` | Reading the queue failed; the loop carries on | `message` |
| `stopped` | Ctrl-C or SIGTERM stopped the loop | |

The agent's own output goes to stderr, so stdout carries only these lines. If
watch cannot start, it prints the usual `{ "ok": false, "error": … }` envelope
and exits 1.
