#!/bin/sh
# Stands in for every agent CLI Leglas looks for. bench/run.ts links it into a
# PATH of its own under each name, so the counts model a machine with every
# agent installed and signed in, whatever the host has. Built-ins only: that
# PATH holds nothing else to call.

# The login probes, answered as signed in by each vendor's rule: Claude reads
# the JSON, Codex the exit code, Cursor the words.
case "$*" in
  "auth status" | "login status" | "status")
    echo '{"loggedIn":true,"status":"Logged in"}'
    exit 0
    ;;
esac

# Anything else waits on stdin until Leglas closes it, answering each JSON-RPC
# request with an empty result. That completes a Codex app-server handshake, so
# a warmed agent stays alive the way a real one does.
while IFS= read -r line; do
  case "$line" in
    *'"id":'*)
      rest=${line#*\"id\":}
      id=${rest%%[!0-9]*}
      if [ -n "$id" ]; then echo "{\"id\":$id,\"result\":{}}"; fi
      ;;
  esac
done
