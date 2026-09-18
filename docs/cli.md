# Command line

```text
leglas init                Prepare a project and teach its agents
leglas [options]           Start the server and open the interface
leglas new <surface>       Scaffold a branch point for a surface
leglas explore <surface>   Brief an agent's exploration of a surface
leglas classify            Decide where a direction should live
leglas add --title T --url U   Register a preview on this machine
leglas list                Show every preview, shared and local
leglas log [entry]         What past explorations decided
leglas show <title>        Everything Leglas knows about one direction
leglas requests            Show change requests made from the interface
leglas watch --run "<cmd>" Hand each request to your agent as it arrives
leglas keep <title> --to <path>  Keep a winner and end the exploration
```

`--json` on any command prints a single machine-readable envelope.
`--port` chooses Leglas's own port and `--user-port` your dev server's;
`--config` names a config file instead of searching upward. Every
command's options are under `leglas <command> --help`.

What each command is for, from an agent's side, is in
[Working with agents](agents.md#what-an-agent-runs).
