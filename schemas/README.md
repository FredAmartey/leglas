# Vendored schemas

`agent-plugins-1.0.0/` holds the JSON Schemas the [Agent Plugins][spec]
standard publishes for `plugin.json` and `mcp.json`, copied verbatim from
`https://agent-plugins.org/schemas/1.0.0/`. They are not ours to edit.

They are vendored rather than fetched so that `plugin.test.ts` validates the
two manifests at the root of this repository without reaching the network,
where an outage or a slow response would fail a run for reasons that have
nothing to do with the change under test.

Each manifest names the version of the standard it targets in its own
`$schema` field, and the test refuses to run unless that version is the one
vendored here. Targeting a newer one means adding its schemas beside these.

[spec]: https://agent-plugins.org/specification
