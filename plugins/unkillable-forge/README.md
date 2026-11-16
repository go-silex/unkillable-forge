# Unkillable Forge local publisher

A separate, profile-isolated MCP publisher for the Unkillable Forge engine. It coexists with the legacy `silex-forge` plugin; installing it does not migrate an instance or retire the old publisher. Supported native clients are Claude Code, Codex and OMP.

## Build and distribution

The runtime requires Node 22 or later on Linux or macOS, on x64 or arm64, and the matching packaged POSIX native payload. Distribute the entire `dist/` directory—including its inventory, shared ESM chunks, native payloads and notices—together with `LICENSE`. The public source catalogue is the installation source; startup does not compile or download code. Build and release do not authorize a deployment or a migration.

## Instance profile

Create an operator-controlled JSON file outside the release directory, with independently approved values for the chosen instance:

```json
{
  "schemaVersion": 1,
  "profileId": "example",
  "instanceId": "example",
  "readOrigin": "https://read.example.invalid",
  "manageOrigin": "https://manage.example.invalid",
  "mcpResource": "https://manage.example.invalid/mcp",
  "approvedAuthorizationIssuer": "https://auth.example.invalid",
  "approvedEndpointOrigin": "https://auth.example.invalid",
  "roots": [{ "id": "artifacts", "absolutePath": "/absolute/path/to/artifacts" }],
  "authProfile": "example"
}
```

Replace every example with operator-approved values. Read and management origins must be distinct HTTPS origins; the MCP resource is the management origin plus `/mcp`. The issuer and endpoint origin must match the independently approved authorization service. Root IDs select preconfigured absolute directories, not arbitrary paths supplied by an MCP caller. Keep credentials and adapter state in a private directory outside the release. Provider login remains native to the client.

## Setup

Use absolute paths for Node, the bundle, profile and private state; select one native client explicitly. The commands below show argument structure, not a live configuration:

```sh
/absolute/path/to/node /absolute/path/to/dist/forge.js profile-check --profile /absolute/path/to/profile.json --client claude-code --state-dir /absolute/path/to/private-state
/absolute/path/to/node /absolute/path/to/dist/forge.js connect --profile /absolute/path/to/profile.json --client claude-code --state-dir /absolute/path/to/private-state
/absolute/path/to/node /absolute/path/to/dist/forge.js config-proposal --profile /absolute/path/to/profile.json --client claude-code --state-dir /absolute/path/to/private-state --name forge-example --node /absolute/path/to/node --bundle /absolute/path/to/dist/forge.js --home /absolute/path/to/home
```

`connect` is an explicit interactive operator action. `config-proposal` prints the proposed per-instance MCP configuration; it does not modify the native client's configuration. Review and install the proposal through the native client, preserving unrelated settings. The generated launch uses an isolated environment. The `stdio` subcommand is the MCP entry point and uses the same profile, client and state arguments.

The state directory must already exist and be owned by the operator with mode `0700`. The configured root may be an operator-selected alias; it is resolved once and its target is bound using no-follow directory handles. Stable private lock files coordinate cooperating local processes and are retained after use; a process exit releases its kernel locks. These locks do not provide cross-machine or network-filesystem guarantees.

## Publishing

Discover `forge_publish` in the configured native client and follow its advertised schema. Select only configured roots. Updates require the caller's explicit working baseline or protected checkpoint; a newer server revision is a conflict, not an automatic rebase. Unselected live resources and pages are preserved; removals are explicit. Local source bytes are streamed by the adapter rather than supplied in MCP tool arguments. A disappeared source is an error, not a deletion.

Use `forge_operation_status`, `forge_resume` and `forge_abort_operation` for an existing operation. Resume retains its original command and identity. A committed publication receipt and subsequent enrichment observation are separate facts: unsupported or failed enrichment does not undo publication. Never paste tokens, share keys or source bodies into model context.

## License

The package is MIT licensed; see `LICENSE`. The build emits the license texts of third-party packages included in the bundle.
