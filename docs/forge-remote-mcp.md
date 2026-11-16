# Remote MCP

The manage Worker exposes a stateless Streamable HTTP MCP endpoint at `/mcp`. Connect to the configured HTTPS management origin using the same Cloudflare Access authentication as the management API. The edge checks host and Origin; a request without Origin must carry an Access assertion and cannot carry cookies. Authentication is repeated for every request. There is no Forge OAuth issuer, dynamic client registration, token proxy, persistent MCP session, or Cloudflare administrative credential in this interface. Cloudflare Access supplies authentication; Catalogue evaluates current authority on each operation.

The server uses MCP SDK 1.32.2 and supports its negotiated protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. JSON response mode is used; clients should send the MCP-specified Accept and protocol headers. Requests are subject to the configured management JSON byte, depth and read-time limits. Tool arguments are strict objects; `tools/list` provides the exact JSON schemas.

## Tools

| Tool | Purpose |
|---|---|
| `forge_catalogue`, `forge_page` | Discover accessible current pages or look up a known page, including authorized tombstones. |
| `forge_page_policy` | Read live policy and grant metadata. |
| `forge_artifact_state` | Read current artifact and CAS metadata. |
| `forge_manifest`, `forge_revisions` | Page through revision manifest sections and retained/discarded revision metadata. |
| `forge_begin`, `forge_materialize`, `forge_seal`, `forge_commit`, `forge_status`, `forge_abort` | Manage publication sessions. |
| `forge_restore`, `forge_unpublish` | Restore or unpublish with current content-version CAS. |
| `forge_upload_descriptor` | Describe the existing authenticated byte upload for a client-sourced file. |
| `forge_visibility`, `forge_share`, `forge_rotate_share`, `forge_revoke_share`, `forge_reveal_share` | Manage page visibility and share grants. `forge_share` accepts a `grant` object with `mode` and, for `pinned`, `revisionId`. |

Tool success is a text JSON object `{ok:true,result:...}`; domain errors return `isError` and `{ok:false,error:{code}}`. Schema/protocol errors are reported by the SDK. Capability descriptions are informational, not authorization; each domain operation checks current authority and CAS.

## Fresh-machine workflow

Discover accessible pages, then inspect the artifact state. Read each manifest section (`files`, `pages`, `edges`) until its cursor is null and inspect revision inventory for restoration. Cursors are consistency selectors, not credentials: each request rechecks current authority and state, and a conflict requires restarting the affected read. A page-scoped grant does not imply access to sibling pages or the full manifest. Historical revision metadata does not imply that sealing or importing a revision activated it; restore eligibility depends on actual commit and retention evidence. Tombstones have no current route. Read-only calls never reactivate grants.

Build publication inputs locally from the returned metadata and local files. `forge_begin` transfers only manifest metadata, not HTML, base64 or file bodies. Use `forge_upload_descriptor` and send the real bytes directly to `PUT /api/publication/upload` with `application/octet-stream` and the caller's own Access authentication; the descriptor is not an authorization capability. Materialize unchanged base files, seal, then commit. Restore and unpublish use their returned state and version inputs, with conflicts resolved by re-reading state. Share keys returned by mint, rotate or reveal are secrets and should not be logged or included in model context unnecessarily.
