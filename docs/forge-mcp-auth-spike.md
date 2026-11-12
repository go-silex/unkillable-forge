# F06 — isolated MCP authentication and byte transport spike

**Status: preparation only, F06 NOT delivered.** The parent performed the local and read-only checks below; no live deployment, client configuration write, real OAuth login, authenticated transfer, refresh or revocation has occurred. The identity fingerprint changes made after those checks are unexercised. Source must be independently reviewed before operations. F06 is independent of F03/F04; this receiver is not the publication API and must not be promoted to production. F08 owns genuine publication and CAS/resume proof.

## Evidence and versions

| Item | Observed / documented | Not established |
|---|---|---|
| Claude Code | installed `2.1.322`; `claude mcp add --help` supports stdio and project scope; `claude --help` supports `--mcp-config` | Actual tool invocation/login |
| Codex | installed `0.163.0`; `codex mcp add --help` supports stdio; `codex --help` shows profile/config overrides | Actual tool invocation/login |
| OMP | installed `18.19.0`; `omp --help` supports `--profile`; [MCP docs](https://omp.sh/docs/mcp) document project `.omp/mcp.json` and profile isolation | Actual tool invocation/login |
| Runtime | Node `26.12.1`, npm `12.2.1`; Wrangler dry-run bundle succeeds | Worker runtime and real Access interoperability unexercised |
| Candidate pins | MCP SDK `1.27.1`, noble hashes `1.8.0`, jose `6.1.3`, zod `4.1.12`, Wrangler `4.59.2`; nested lockfile generated, 132 packages installed | npm reported install scripts blocked for esbuild, sharp and workerd; no policy bypass; workerd runtime remains unexercised |

Installed SDK `1.27.1` declarations were read: `client/auth.d.ts` exposes the provider callbacks and resource validation used here; `server/webStandardStreamableHttp.d.ts` documents Worker support, `enableJsonResponse` and stateless mode without a session generator. Parent initialized the actual stdio SDK and listed tools; Cloudflare and client interoperability remains unproven.

[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) documents opaque bearer tokens, RFC 8707, dynamic localhost registration, PKCE-compatible authorization flow, configurable refresh and policy re-evaluation at refresh. The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) requires protected-resource discovery and resource indicators. [SDK 1.27.1 OAuth source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.27.1/src/client/auth.ts) supplies discovery, PKCE, registration and refresh. The adapter requires advertised resource to equal its configured `/mcp` URL; a different real Cloudflare PRM value is an explicit compatibility failure, not silently weakened. The origin must verify Cloudflare's assertion: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). Never treat the opaque bearer as a JWT or trust a supplied header without signature, issuer and audience verification.

[Claude project MCP](https://code.claude.com/docs/en/mcp), [Codex project configuration](https://developers.openai.com/codex/config-reference), and [OMP project/profile MCP](https://omp.sh/docs/mcp) describe configuration sources. Project trust/approval and OMP's automatic import of other clients' configurations require inspection during execution; an isolated project alone does not prove other servers are inactive. The MCP server must be explicitly selected and genuine tool-call traces captured. The adapter owns its OAuth client; harness OAuth credentials are never copied.

## Files and limits

- `spikes/f06/receiver.mjs`: Worker validates `Cf-Access-Jwt-Assertion`, expected issuer, audience, RS256, required expiry, issued-at and subject. JWKS are cached per validated issuer, never authorization decisions. `PUT /mcp` incrementally hashes received bytes and returns size/hash without storing content; stateless MCP exposes metadata only.

Identity evidence is `identitySha256`: lowercase SHA-256 of UTF-8 `JSON.stringify(['forge-f06-identity-v1', issuer.origin, sub])`, computed only after assertion verification. JSON array encoding preserves tuple boundaries. It appears in authenticated PUT receipts and `receiver_info`, and the adapter validates and returns it with each file receipt. It is a stable **linkable pseudonym**, not anonymous, and is not an authorization or revocation decision. Compare it across three client runs for the same approved test identity and preserve results as protected evidence; no raw JWT, issuer/sub pair or email is returned.
- `spikes/f06/adapter.mjs`: local stdio `transfer_fixture(localPath)` confines resolved paths to the required absolute `F06_FIXTURE_ROOT`, walks files, opens regular files without following final symlinks, streams each to the receiver and compares local and remote SHA-256 and size. 100 files, 16 MiB/file; local paths and file names are metadata, not bodies. Use only a synthetic fixture directory that is immutable during the run and mode 0700: directory components can be swapped concurrently; this prototype is **not safe for hostile/mutable trees or production publication**. Failures provide sanitized stage/code and observed HTTP status where available; no diagnostic log is implied.
- `spikes/f06/oauth.mjs`: SDK OAuth with private profile/resource-scoped cache under `$XDG_CACHE_HOME/forge-f06` or `~/.cache/forge-f06`, directory 0700 and file 0600; fresh state and PKCE verifier remain local, callback validates loopback Host and redirects to clean `/complete` before displaying status. Browser sees a loopback start URL; tokens never enter CLI args or model output. Cache is not an OS keychain; protect the host account. Run only one adapter authorization at a time (fixed port 39875); separate profile name per harness. Never use `forge.env`, a CF token, S3 keys, or harness credentials.
- `spikes/f06/fixture.mjs`: writes a synthetic multi-MiB HTML and CSS/SVG relative assets to a **new** directory. Never generate inside the worktree; no customer bytes.
- `spikes/f06/wrangler.jsonc`: neutral Worker entrypoint; alternate public preview routes disabled. Operator must supply the fresh Worker name, custom domain and the three variables in a private configuration outside the repository, after approval. Account ID is selected explicitly in that private configuration, not by a default.

The parent exercised local negative boundaries and a Wrangler dry-run as recorded below. Those do not prove positive Access authentication, real Worker execution, or the later identity fingerprint change. It is unknown whether Managed OAuth covers `PUT` on the same exact resource and whether its real PRM resource equals `/mcp`; if it does not, stop and retain sanitized metadata/status evidence. Do not add a second OAuth stack under Managed OAuth. Exact measured failure is required before considering an explicitly approved standalone application OAuth provider backed by Access identity; no shared secret or admin workaround.

## Bounded operation profile — proposed, not authorized

1. **Exact candidate:** GOSILEX account, fresh Worker name `forge-f06-1fd930f85c34`, sole intended hostname `forge-f06-1fd930f85c34.unkillablecompanies.com`. Parent verified GOSILEX is present in existing Wrangler OAuth and read-only Access app lookup for this exact host returned 200 with zero apps. This does **not** prove DNS freshness, absence of every route/Worker collision, or Access-write permissions. Inspect these separately without mutations and maintain all actual account, application and resource IDs privately. Source review and explicit owner approval precede every scoped mutation.
2. Create only the new Worker, new host routing/DNS as explicitly approved, and a dedicated new Access app for the whole host and all `/mcp` methods. Existing apps, roles, app credentials, routes, legacy and production resources remain untouched. Disable preview and workers.dev; check wrong-host and unconfigured receiver are closed. No bindings. Explicitly verify account, hostname, issuer and app audience against the private manifest; never commit identifiers or secrets.
3. Enable **Managed OAuth** on that new app, not a second authorization server: public dynamic registration, loopback `127.0.0.1:39875/callback`, access token lifetime `5m`, grant session `24h` and a dedicated restrictive policy for the specifically approved test identity. These settings are documented by the [Managed OAuth primary reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/). No assumptions about Access-write privilege. Existing Wrangler identity reports Workers/scripts/routes write and zone read only; that is not DNS-write or Access-write proof. An operator handles any separately authorized least-privilege provisioning; publishers get no CF credentials.
4. After independent source review and approval, install from the nested lockfile in an isolated copy and execute parent-owned tests. Resolve npm's blocked dependency install scripts only under the operator's policy. Generate fixtures in a protected new temporary directory. Prepare separate temporary project configurations: Claude `--mcp-config` or project `.mcp.json`, Codex trusted project `.codex/config.toml` or isolated home, OMP `.omp/mcp.json` with a fresh `--profile`. Each starts `node <absolute-path>/adapter.mjs` with nonsecret `F06_RESOURCE=https://<fresh-host>/mcp`, absolute `F06_FIXTURE_ROOT` pointing to the immutable mode-0700 fixture directory, and unique `F06_PROFILE` (`claude`, `codex`, `omp`). Do not change principal config. Confirm no imported foreign server is active; use the real client in order Claude → Codex → OMP, with interactive consent. Configure the chosen sandbox to permit reading only the synthetic fixture and reaching this host and loopback callback.
5. For each client call `transfer_fixture` first on the generated HTML then its containing directory. Capture sanitized actual client tool-call traces and returned SHA-256/size and identity pseudonyms; compare each receiver hash to independently computed local hashes, including relative assets, and compare identity pseudonyms between all three runs. Observe a genuine refresh after expiration with no interactive login, then revoke the isolated test identity only and record whether the existing token still works, the exact elapsed time, and denial of later requests and refresh. Retain timestamps and status codes, no raw tokens. Reconnection after regrant is a separate test. Access policy revocation may not be immediate: it is reevaluated on refresh, not equivalent to the future immediate D1 application revocation guarantee.

On completion, stop traffic and obtain explicit owner authorization for deletion of **only the exact IDs created for this spike and recorded in the private manifest**: Worker, DNS/route, Access application/policy and local temporary profile/cache/fixture as applicable. Inspect dependencies before deletion; never delete by wildcard or touch pre-existing resources. Separately consider OAuth grants and registrations and record any provider retention. Do not delete or rotate principal credentials. Cleanup and proof of absence are themselves unexercised.
### Isolated configuration shapes

These are recipes for the future approved run, not executed commands. Copy the package and lockfile to a private scratch directory, then `npm ci` there subject to the install-script policy. Run `node fixture.mjs <new-absolute-fixture-directory>` there, with the fixture outside the copied package. The Worker requires `TEAM_DOMAIN` (Access issuer origin), `POLICY_AUD` (new app audience) and `EXPECTED_HOST` (fresh hostname, no scheme). Use a protected private Wrangler configuration pointing to the copied `receiver.mjs`; deploy the reviewed source only after the exact host and account have been approved. Worker metadata MCP and raw byte PUT both use `/mcp`.

For a temporary Claude `--mcp-config` JSON file or temporary OMP `.omp/mcp.json`, use an `mcpServers` entry of this shape, substituting real **nonsecret** scratch paths and host:

```json
{"mcpServers":{"f06":{"command":"node","args":["/absolute/scratch/adapter.mjs"],"env":{"F06_RESOURCE":"https://fresh-host.example/mcp","F06_PROFILE":"claude","F06_FIXTURE_ROOT":"/absolute/scratch/fixture"}}}}
```

For OMP use a separate profile and replace `claude` with `omp`. For Codex use a trusted temporary project's `.codex/config.toml`:

```toml
[mcp_servers.f06]
command = "node"
args = ["/absolute/scratch/adapter.mjs"]
[mcp_servers.f06.env]
F06_RESOURCE = "https://fresh-host.example/mcp"
F06_PROFILE = "codex"
F06_FIXTURE_ROOT = "/absolute/scratch/fixture"
```

These example hostnames/paths are syntax illustrations, not deployable targets. Browser authentication requires the loopback server to remain reachable while the tool call runs; a sandbox that denies it blocks the proof. The SDK's exception details are deliberately not passed back to the model; diagnostic instrumentation, if needed, must be reviewed to prevent credential leakage.

### Client launch syntax

The installed help and linked primary docs support the following future interactive launches, from approved isolated scratch projects. They configure a **local stdio adapter**, not native remote-client OAuth:

| Client | Launch and configuration | Isolation boundary |
|---|---|---|
| Claude Code | `claude --mcp-config /absolute/scratch/f06-mcp.json --strict-mcp-config` | Strict flag excludes other MCP configurations; user/model authentication remains Claude's own. |
| Codex | `codex -C /absolute/scratch/project` with the TOML above at that trusted project's `.codex/config.toml` | Project config loads only after trust. `codex --profile f06` instead layers `$CODEX_HOME/f06.config.toml` over base user config; a profile alone does **not** isolate the base configuration. Inspect effective servers and ensure no unrelated servers are used. |
| OMP | `omp --profile f06 --cwd /absolute/scratch/project` with the JSON above in `.omp/mcp.json`, or in `~/.omp/profiles/f06/agent/mcp.json` | Profile is isolated, but OMP can import other clients' definitions. Inspect `/mcp list`; the adapter itself owns OAuth, so do not use OMP `/mcp reauth` for it. |

These flags were observed in installed CLI help. No configuration or launch has been executed for this matrix. Consent, client/provider authentication and sandbox allowances must be obtained without copying harness credentials into the adapter.

Parent's protected evidence identifiers: `F06-local-sdk-boundary-smoke`, `F06-local-worker-dry-run-bundle`, `F06-readonly-access-capability`, `F06-existing-wrangler-operator-identity` under the private F02 evidence root. They are not public artifacts or proof of the post-check source changes.


## Acceptance ledger and blockers

| Criterion | State |
|---|---|
| Client versions/help and primary documentation | Observed/read as above |
| Local SDK and receiver boundaries | Parent: actual stdio SDK initialized, tool list obtained, out-of-root path rejected before network; Node receiver wrong host 404, Origin 403, missing assertion 401, malformed assertion 403. Three synthetic files; HTML 4,587,649 bytes, independent hashes retained privately. Positive authentication not exercised. |
| Worker bundle | Parent: Wrangler `4.59.2 deploy --dry-run` exit 0, 901.38 KiB / gzip 167.39 KiB, no bindings, no deployment or script-policy bypass. Does not prove Worker execution. |
| GOSILEX capabilities | Parent: existing Wrangler OAuth lists GOSILEX and Workers/scripts/routes write, zone read; exact-host Access-app GET returned 200, zero applications. DNS availability, DNS-write and Access-write remain unknown. |
| Three actual clients, OAuth discovery, PKCE, callback, RFC 8707, authenticated streamed bytes/hashes, identity stability | **Not exercised** |
| Refresh, denial after revocation, elapsed revocation window, reconnection | **Not exercised** |
| Fresh resource creation and deletion approvals | **Not granted** |

Before execution parent must review source including package pin compatibility and all security boundaries, resolve any findings, then obtain the explicit approvals above. This document does not authorize any live mutation. The SDK selection and PRM/PUT compatibility remain hypotheses, not a Cloudflare failure or proof of support. No claim of F06 completion may be made until the complete real-client matrix passes.
