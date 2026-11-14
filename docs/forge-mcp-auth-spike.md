# F06 — isolated MCP authentication and byte transport spike

**Evidence snapshot, 2026-11-14:** see the [F06 report and decision](forge-mcp-auth-report.md) for completed native matrices, separately observed protocol responses and isolated cloud retirement. Final acceptance is conditional on independent final-SHA review, required CI and merge; PR [#8](https://github.com/go-silex/unkillable-forge/pull/8) and the project ledger carry their live state. This temporary receiver and local file-transport experiment is not F07 remote publication or F08 publication/CAS. Reviews of `863de80861a0ebbf49b350c82fa3e113a0c87763` and `70826d99b5134c6de02492fd5d21a181f44b3e0f` were NOT CLEAR. Review of `040b3e90e97acace8c5ec9d12762bd03fffde7bc` closed N1/N2/N3 but blocked wrong-resource classification; the later correction was locally exercised. The subsequent authorized isolated live cycle and native matrices are described in the report, not retroactively attributed to those historical reviews.

**Retirement snapshot:** final readback found both owned domains, Workers and Access apps absent, no exact-name DNS and no residual owned policies. The two associated packs and leaves were observed deleted without a certificate DELETE by the operator or agent; the cause is unknown. The six baseline packs and recorded leaves were preserved. See the report for evidence and historical partial-stop details.

## Versions and security

| Item | Source / evidence | Limit |
|---|---|---|
| Claude Code `2.1.322`, Codex `0.163.0`, OMP `18.20.0` | Native matrix and subsequent startup probe receipts at source `c305cb8941312d13e92fb5066925a34c2ffd7d16` | All three completed file, directory, refresh, post-revocation denial and regrant. Later startup probes observed Claude and OMP `2025-11-25`, Codex `2025-06-18`; the earlier matrices did not capture protocol dates. |
| Node `22.23.4` | Explicit runtime used for the isolated cycle | Previous local Node `26.12.1` observation was not the live-cycle runtime. |
| MCP SDK `1.32.2`, Zod `4.6.7` | Exact pins and nested lockfile; [npm SDK](https://registry.npmjs.org/@modelcontextprotocol%2fsdk/latest), [npm Zod](https://registry.npmjs.org/zod/latest) | SDK protocol baseline and observed live interoperability are distinguished in the report. |
| Other pins | noble hashes `1.8.0`, jose `6.1.3`, [Wrangler `4.161.0`](https://registry.npmjs.org/wrangler/4.161.0) | Earlier npm blocked esbuild `0.28.2` and workerd `1.20261110.1` postinstall scripts; a dry-run bundle alone was not workerd runtime proof. |

[OSV GHSA-6qxp-vccf-f47h](https://osv.dev/vulnerability/GHSA-6qxp-vccf-f47h) fixes SDK issuer binding in 1.31.0; old cached credentials without `issuer` are **refused**, not silently rebound. New client information and tokens are stored unchanged with their issuer. The historical review also identified SDK cross-origin OAuth redirect and oversized-request advisories. [OSV GHSA-mrhx-c7xc-m3w5](https://osv.dev/vulnerability/GHSA-mrhx-c7xc-m3w5) fixes Zod in 4.6.6. The exact-version OSV checks below cover the two direct pins, not all transitive dependencies.

Parent's read-only OSV API POST exact-version queries for SDK `1.32.2` and Zod `4.6.7` each returned HTTP 200 and zero advisories on 2026-11-13; protected evidence `F06-corrected-direct-dependency-OSV`. This is not a transitive or global audit.

Installed SDK `1.32.2` OAuth implementation was read after `npm ci`: it stamps credentials with the discovered issuer and performs token POSTs through same-origin redirect handling. Its source explicitly says it does **not** verify the metadata document echoes the discovery issuer; this spike independently requires the metadata issuer to equal `F06_AUTH_ISSUER`. Source inspection is not an execution test.

[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) documents opaque tokens, RFC 8707 prerequisite, discovery, and refresh with policy reevaluation. It does **not** establish PKCE enforcement. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) describes PKCE and resource indicators. [SDK source at npm gitHead](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/src/client/auth.ts) shows issuer-bound credential handling and OAuth flows. `S256_METADATA_ABSENT` means metadata did not advertise S256, not that PKCE is unsupported or unenforced. A PRM resource mismatch is `PRM_RESOURCE_MISMATCH` plus a sanitized URL, not a conclusion that Managed OAuth is unsupported: real app/resource mapping must be examined. No second OAuth stack is layered beneath Managed OAuth.

## Prepared code and evidence boundaries

- `spikes/f06/receiver.mjs`: validates Access assertion issuer/audience, RS256, `exp`, `iat` and `sub`; JWKS cache only. It hashes incoming PUT bytes, does not store them, and exports metadata-only stateless MCP. It sends the SHA-256 of UTF-8 `JSON.stringify(['forge-f06-identity-v1', issuer.origin, sub])` only in a response header to the local adapter, never in MCP tool output. This value is linkable, not anonymous; no raw JWT, sub or email is returned.
- `adapter.mjs`: `transfer_fixture(localPath, authMode?)` reads only below absolute `F06_FIXTURE_ROOT`, streams fixture bytes and checks actual server hash and size. It writes one bounded `identity.json` fingerprint per profile/resource in the protected cache (0600), for operator-only comparison. Receipts expose paths, sizes and byte hashes, not identity. Cache and temporary evidence remain outside the project. Fixture root must be immutable and mode 0700 during runs: ancestor replacement races remain outside this spike's threat model; this is not production file handling.
- `oauth.mjs`: adapter-owned SDK OAuth and profile/resource cache, no harness credentials or CF admin credentials. `authMode` is `interactive` (default), `noninteractive` (present cached token, then refresh on 401 without a browser or new grant), or `refresh-only` (force refresh without cached-token presentation or interactive fallback). Results expose `authPath` and, when applicable, the first `cachedHttpStatus`, refresh HTTP status or sanitized OAuth error. Concurrent authentication returns `AUTH_IN_PROGRESS`; cancellation passes the MCP signal to network and closes the callback listener. Missing PRM and missing authorization servers report `PRM_UNAVAILABLE` and `PRM_AUTHORIZATION_SERVERS_MISSING` before issuer checks; a challenge that does not name same-origin HTTPS PRM is refused.
- `negative-probe.mjs`: operator-only wrong-verifier and wrong-resource experiments on separately approved isolated apps. The historical proposed control was subsequently authorized and executed; live rejection and positive-control evidence are in the report. Do not share harness caches, automatically re-register, or log tokens or callback URLs. The wrong-resource test verifies same-principal positive controls before and after the cross-resource request; a 405, origin denial, malformed response or other unproved outcome is inconclusive. Wrong-verifier `invalid_grant` is rejection evidence; S256 advertisement alone is not.
- `fixture.mjs` generates synthetic multi-MiB HTML plus relative CSS/SVG assets only at runtime. `wrangler.jsonc` is neutral, has no bindings, workers.dev or preview URLs; operator supplies exact isolated settings in a private config. `.dev.vars` is not a safe repository destination: keep all sensitive runtime config outside Git.

## Existing observations — not final-SHA proof

| Evidence reported by parent | What it does not prove |
|---|---|
| Corrected source, SDK `1.32.2`: parent initialized real stdio and listed tools; existing and nonexistent out-of-root paths returned the same `PATH_OUTSIDE_FIXTURE_ROOT` before network; PRM mismatch produced an explicit code and URL with userinfo/query/fragment removed. | Actual Claude/Codex/OMP invocation or live OAuth discovery. |
| Earlier corrected source under Node: wrong host 404, Origin 403, absent assertion 401, malformed assertion 403. With explicitly substituted **synthetic JWKS**, a real RS256 signature with wrong audience returned 403; a real 4,587,649-byte stream matched an independently computed hash; identity was in a private header, not MCP tools; stateless MCP initialize/list/tool and authenticated receiver GET succeeded. | Cloudflare Workers, real Access-issued identity, real user login, SDK token refresh or production behavior. Synthetic keys are not Cloudflare proof. |
| Corrected-source Wrangler `4.59.2 deploy --dry-run`: first attempt exited 1 because the neutral config lacked an explicit name; the parent reran only that failed step with the proposed `--name` and got exit 0, 973.44 KiB / gzip 185.10 KiB, no bindings or deployment. | Workerd execution, runtime CPU capacity, production compatibility or CI pass. |
| Baseline `040b3e9`: native stdio, synthetic-JWKS receiver and the 4,587,649-byte stream passed. The real SDK ran against explicitly synthetic HTTP: cached token 200; cached token 401 → refresh 200; revoked refresh `invalid_grant` 400 with initial cached status 401 and no interactive authorization; missing PRM and missing authorization servers retained their distinct diagnostics. | These local control-flow checks are not actual Access, a live revocation, wrong-verifier/cross-app execution, or the three-client matrix. |
| Baseline `040b3e9`, Wrangler `4.161.0 deploy --dry-run`: exit 0, 971.73 KiB / gzip 184.83 KiB, no bindings, no deployment. Nine runtime/config/lock inputs and the driver had identical pre/post SHA-256 fingerprints, independently matched to that commit. | No deployed Worker or workerd execution. The later negative-probe change is covered by a separate narrow proof, not falsely attributed to this baseline. |
| The actual changed `negative-probe.mjs` ran seven cases: edge rejection; valid foreign-token acceptance; Worker 401; malformed 2xx; different principals; 405; edge 403. Only verified rejection exits 0; verified acceptance is explicit and exits 1; the five unproved outcomes stay inconclusive. Nine inputs plus this driver's hashes were unchanged during that run. | OAuth `ensure` and HTTP were explicitly substituted; this proves classification, not real OAuth, Access or cross-app binding. The other eight runtime/config/lock files match the baseline; its unchanged checks were not repeated. |
| Existing Wrangler OAuth authenticated and GOSILEX present, Workers/scripts/routes write and zone read. Previously expired cache caused direct API 403/9109; native `wrangler d1 list` refreshed the **existing grant**, but its read failed 10000 due to D1 permission. Refreshed OAuth GET zones returned 200/13, all account matches, including `unkillablecompanies.com` and `gosilex.com`: zone ownership established. | D1 access, Access-write, DNS-write, or authorization to create resources. |
| Legacy scoped token Access apps exact-host GET 200/0 and zone GET 200/0. Refreshed OAuth DNS exact-host GET 403/10000. New Worker settings GET 404/10007. | Legacy 200/0 is **not** evidence of absence or visibility ([existing Access caveat](cloudflare-access.md)); exact host filtering misses wildcard apps; DNS 403 is not absence; Worker 404 does not establish DNS or Access freshness. |
| Baseline `040b3e90e97acace8c5ec9d12762bd03fffde7bc`: manual CI `43427178724` completed all five jobs successfully, release skipped. | The root CI does not exercise this nested spike, and does not validate the later probe correction. |

Protected baseline evidence: `F06-v2-input-bound-local-smoke-and-bundle`, SHA-256 `3f1a00fa2db6e30a40c07556f3aa5d27da4e789e63e2314ede1614b6fc1be740`; committed binding `F06-v2-committed-input-binding`, SHA-256 `3383e37dfd260fd9e4784730abf756e8df4094510d7cc214e042fe89f960eb66`. Those nine inputs bind to `040b3e9`, not automatically to a later commit.

Protected narrow proof: `F06-v3-input-bound-negative-probe-smoke`, SHA-256 `85fd4b50a384b81728033374bc139660c935e292500c3eaf1bc97a74370011da`. It records all seven actual probe-module results and before/after hashes of nine runtime/config/lock inputs plus the new driver. Only `negative-probe.mjs` differs from the baseline; the baseline smoke/bundle never imports it. Final attribution is therefore composite: match eight unchanged inputs to the baseline and the changed probe to this narrow proof. Both drivers import reviewed worktree source directly, not copied source.

Earlier protected evidence: `F06-corrected-local-sdk-and-bundle-proof`, `F06-corrected-worker-bundle-named-proof`, `F06-corrected-direct-dependency-OSV`, `F06-local-sdk-boundary-smoke`, `F06-local-worker-dry-run-bundle`, `F06-readonly-access-capability`, `F06-existing-wrangler-operator-identity`. These older smoke runs did not capture pre/post source hashes and are not cryptographic final-SHA proof. All records are under the protected F02 evidence root. No raw account IDs, emails, JWTs, credentials or fixture bodies belong in public records.

## Historical bounded operation profile — subsequently authorized for the isolated cycle

1. **Historical proposal, not current authorization:** GOSILEX, a new Worker and sole host for this temporary cycle. Before operation, verify exact and wildcard Access apps with complete account visibility, DNS and route collisions and required write permissions. Unknown is not absent. No existing app, role, identity-provider account, legacy route, production setting or server may be changed. Native refresh of an already authorized operator grant is distinct from rotating, revoking or expanding existing credentials.
2. With explicit creation authority, provision only the new Worker, dedicated Access app/policy and necessary fresh DNS/routing identities in the verified GOSILEX zone. Record exact created IDs privately. No bindings; disable workers.dev/preview and verify host/issuer/AUD and fail-closed unconfigured and unauthenticated routes. Operator deploys the reviewed source via least privilege; publishers never receive admin credentials.
3. Enable **Managed OAuth** only on the new app: public dynamic client registration, loopback `127.0.0.1:39875/callback`, access lifetime `5m`, grant lifetime `24h`, restricted test identity; values follow the [Cloudflare example](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/). No alternative/custom OAuth server, no shared ops secret, no modification of existing apps or grant rights. The later authorized cross-app control used a second isolated app; it was not an OAuth fallback.
4. Run parent-owned local tests and approved real matrix Claude Code → Codex → OMP with an immutable 0700 synthetic fixture and separate cache profiles. Capture actual tool calls, actual byte hashes, identity fingerprint comparison privately, metadata presence/S256, callback and RFC 8707 indicators. Exercise `authMode: "refresh-only"` after expiry and record genuine refresh outcome and OAuth code. Run wrong-verifier and controlled wrong-resource probes **before revocation**, while the app1 control profile remains valid. Revoke only the newly created test app's scoped policy/grant after explicit authorization, then use `authMode: "noninteractive"` to observe cached-token HTTP status and, on 401, refresh outcome without browser or regrant; distinguish a still-valid current token from a rejected refresh. Never revoke the global IdP identity, account or existing access. Test reconnect only after specifically authorized regrant. Retain sanitized evidence; mark unsupported or unobserved checks inconclusive.
5. Before cleanup obtain explicit owner authorization and delete only the exact new Worker, DNS/route, Access app/policy, grants and local files created and recorded for the spike. Verify absence with appropriately scoped credentials. Never delete by wildcard or touch pre-existing resources or global identities. No cleanup authority is implied by engine-first development.

## Isolated client profiles — historical run configuration

Create the following config in a protected scratch project, substituting actual nonsecret paths. `F06_RESOURCE` is `https://forge-f06-1fd930f85c34.unkillablecompanies.com/mcp`; `F06_FIXTURE_ROOT` is the absolute immutable fixture root; use distinct `F06_PROFILE` values for each harness. `F06_AUTH_ISSUER` is the exact HTTPS authorization-server issuer verified by the operator against the approved app's control-plane configuration and discovery metadata; discovery metadata alone is not independent proof. It is not the Access assertion issuer and must not be guessed. A mismatch fails closed before registration or token exchange. Set it for the negative probes as well.

The spike additionally requires the advertised authorization endpoint and token/registration POST endpoints to use the approved issuer's HTTPS origin without query parameters, and the metadata `issuer` to match the approved issuer. `AUTHORIZATION_ENDPOINT_ORIGIN_MISMATCH` and `OAUTH_ENDPOINT_ORIGIN_MISMATCH` are explicit client security boundaries, not evidence that Managed OAuth is unsupported; if real metadata uses another origin, stop for source/security review rather than relaxing the check silently.

The model client retains its own native provider login. Only its MCP child gets the clean environment below: no inherited Cloudflare/provider variables, and separate protected HOME/cache paths. Prepare those directories with mode 0700. The `env -i` wrapper is required; a normal MCP `env` table adds values without removing inherited secrets. With this environment, automatic browser launching may be unavailable: the operator can open the fixed loopback start URL in their existing browser. Do not copy callback codes or OAuth credentials into the model.

The adapter executable below is read directly from the approved detached worktree SHA with its adjacent locked `node_modules`; do not copy the source into scratch. The HOME, cache and synthetic fixture remain private scratch paths.

```json
{
  "mcpServers": {
    "f06": {
      "command": "/usr/bin/env",
      "args": [
        "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=/absolute/scratch/adapter-home-claude",
        "XDG_CACHE_HOME=/absolute/scratch/adapter-cache-claude",
        "F06_RESOURCE=https://forge-f06-1fd930f85c34.unkillablecompanies.com/mcp",
        "F06_AUTH_ISSUER=https://approved-issuer.example",
        "F06_PROFILE=claude", "F06_FIXTURE_ROOT=/absolute/scratch/fixture",
        "/absolute/path/to/node", "/absolute/detached-worktree/spikes/f06/adapter.mjs"
      ]
    }
  }
}
```

- Claude: `claude --mcp-config /absolute/scratch/f06-mcp.json --strict-mcp-config` ([docs](https://code.claude.com/docs/en/mcp)).
- Codex: `codex -C /absolute/scratch/project`, trusted project `.codex/config.toml`:

```toml
[mcp_servers.f06]
command = "/usr/bin/env"
args = [
  "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/absolute/scratch/adapter-home-codex",
  "XDG_CACHE_HOME=/absolute/scratch/adapter-cache-codex",
  "F06_RESOURCE=https://forge-f06-1fd930f85c34.unkillablecompanies.com/mcp",
  "F06_AUTH_ISSUER=https://approved-issuer.example",
  "F06_PROFILE=codex", "F06_FIXTURE_ROOT=/absolute/scratch/fixture",
  "/absolute/path/to/node", "/absolute/detached-worktree/spikes/f06/adapter.mjs"
]
tool_timeout_sec = 300
```

  `codex --profile f06` layers `$CODEX_HOME/f06.config.toml` on base config; it is not isolation by itself ([config reference](https://developers.openai.com/codex/config-reference)).
- OMP: `omp --profile f06 --cwd /absolute/scratch/project`, the wrapped JSON above in `.omp/mcp.json` or `~/.omp/profiles/f06/agent/mcp.json`, with `F06_PROFILE=omp` and separate `adapter-home-omp` / `adapter-cache-omp` paths. Check `/mcp list` for automatic imports ([docs](https://omp.sh/docs/mcp)). Harness OAuth is not copied; the adapter independently authenticates.

These profiles describe the historical isolation pattern, not permission to run again. Actual launches, protocol observations, live results and cloud retirement are recorded in the [report](forge-mcp-auth-report.md); the earlier local smoke, synthetic controls and dry-run remain distinct historical evidence. Both historical reviews remain NOT CLEAR. Final acceptance depends on independent review, required CI and merge on the final SHA.
