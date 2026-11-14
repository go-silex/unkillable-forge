# F06 — MCP authentication and byte-transport report

**Evidence snapshot, 2026-11-14:** the three native authentication and transport matrices passed, protocol responses were observed separately, and the isolated cloud cycle was retired with final readback. This is not business publication. Acceptance is conditional on independent final-SHA review, required CI and merge; consult PR [#8](https://github.com/go-silex/unkillable-forge/pull/8) and the project ledger for their live state. The operational source was `c305cb8941312d13e92fb5066925a34c2ffd7d16` in an approved detached worktree with unchanged source bytes; the documentary head differs. Historical reviews and synthetic/local evidence remain in the [spike runbook](forge-mcp-auth-spike.md).

## Decision and boundaries

- **Authentication:** retain Cloudflare Access Managed OAuth as the F06 choice. The three native clients used separate adapter-owned SDK grants, not an operator grant. Their model-provider login remained native and normal; no provider credentials were copied. The MCP child was launched with an `env -i` isolation boundary and without inherited provider or Cloudflare administrator variables. The live evidence does not require an alternative OAuth broker or an authless fallback.
- **Runtime:** the isolated cycle used explicitly selected Node `22.23.4`; exact pins include Wrangler `4.161.0`, TypeScript MCP SDK `1.32.2`, and Zod `4.6.7`. Native clients: Claude Code `2.1.322`, Codex `0.163.0`, OMP `18.20.0`.
- **Protocol baseline:** SDK `1.32.2` implements the legacy MCP `initialize` handshake, preferring `2025-11-25` and also accepting `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. Its HTTP default when the version header is absent is `2025-03-26`. F06 uses a local stdio adapter and a stateless Streamable HTTP receiver with JSON responses and no MCP session ID.
- **No 2026 claim:** MCP `2026-07-28` is not implemented or tested by this SDK; it is not a demonstrated compatibility target. Later startup-only observations established the protocol response per client at probe time, not retroactively during the earlier matrices. Successful tool calls alone do not establish the protocol: this SDK server can process calls before `initialize`. The operator's remote HTTP initialize/list/call control passed, but its protocol string was not captured; `2025-11-25` follows from the SDK client/server source, not that receipt. See [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) and [2026 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- **Production boundary:** this code is proof-only, never a production import or fallback. No F04 HTTP/config dependency is established. F08 owns real R2 publication and the complete three-client business-publication proof; F07/F08 must decide their own protocol-era support rather than assume F06 proves modern-only compatibility.

## Native matrix — observed at the operational source

All three clients completed the same five cases: separate interactive Managed OAuth authorization and single-file transfer, directory transfer, natural cached-token HTTP 401 followed by refresh HTTP 200, denial after the scoped grant's revocation, and successful interactive regrant. Denial was observed before credentials were invalidated for regrant. The receipt's native tool result, rather than process exit alone, determines whether a call was denied. These are stateless authentication and transport results, not a persisted R2 publication.

| Client | Version | Protocol observed at later startup probe | Matrix evidence |
|---|---|---|---|
| Codex | `0.163.0` | `2025-06-18` | Four immutable receipts below: file/directory, refresh, denial, regrant. |
| OMP | `18.20.0` | `2025-11-25` | Complete matrix receipt below; the earlier partial remains historical. |
| Claude Code | `2.1.322` | `2025-11-25` | Complete matrix receipt below; the earlier partial and browser-verification block remain historical, superseded for this client's completed matrix. |

These later no-prompt, no-tool startup probes observed `initialize` responses with Node `22.23.4`, SDK `1.32.2`, and server `forge-f06-local` `0.0.0`. Each used a fresh empty MCP child home/cache and profile, without borrowing an MCP grant or copying provider credentials. Hashed probe inputs and native binaries were stable before and after against approved source `c305`; the observer was independently reviewed CLEAR. Claude registered the hashed server definition in a fresh native home and ran `mcp list` health check for the one configured server; its native-generated settings file was **not** hashed before registration. Codex used a fresh native home and app-server initialization, an ephemeral thread and MCP status list without a model turn. OMP used its normal model profile, a new project MCP config and disabled-provider overlay, with RPC ready/get_state; its top-level tool dump is not a complete mounted-server inventory.

Claude's observer recorded pre-initialize error code `-32601`; the method was not captured, so this does not establish `server/discover` or support for both protocol eras. These are observations at probe time, not proof of which version the earlier five-case matrix negotiated.

The synthetic single HTML file was **4,587,649 bytes**, SHA-256 `5ff9cd03159399cabed51ee8693e504a28897164039c2422447384a83707d452`. The directory contained `index.html` with those same bytes, `assets/style.css` (19 bytes, SHA-256 `98622e0579fea1db137dc6bdd2b373dd60d647607b6c994cbcc9df40f2e6dca1`) and `assets/pixel.svg` (96 bytes, SHA-256 `5773e4fc1ba216be1edbc6a0d78bba2d92445ef700ebcb1f3c285df9e031194f`). The adapter compared streamed size and hash; this is not evidence that a model read or published the file contents.

The separate operator control transferred exactly **16,777,216 bytes**, SHA-256 `080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e`, with independently matched metadata. This boundary control was not a native-client matrix case or publication proof. The separate remote MCP operator control initialized, listed and called `receiver_info`; it did not transfer a file and was not a native-client test.

## Security and revocation observations

- A live wrong-PKCE-verifier exchange was rejected with HTTP 400 `invalid_grant`. A separately controlled wrong-resource token was rejected with HTTP 401 and an Access challenge; positive controls on both resources and the target before and after the negative request succeeded for the same principal. These are operator controls, not native-client proofs. S256 metadata alone would not establish enforcement.
- Codex's historical sequence received HTTP 200 for refresh-token revocation, then HTTP 400 for the access-token revocation request; the 400 cause is **unattributed**. Native denial followed after the short access lifetime, with cached HTTP 401 and failed refresh `invalid_grant`. This does not prove instant native access-token revocation or a particular cascade.
- Separate access-first own-grant controls observed an access denial before refresh revocation at approximately **75 ms** for the operator, **84 ms** for OMP and **73 ms** for Claude. These are observations on those specific runs, not global maximum propagation times, causality guarantees or an immediate-revocation SLA.
- F03's application roles — reader, explicitly assigned publisher and administrator — require fresh authorization decisions from the primary D1, independently of Cloudflare access; D1 unavailability fails closed. Managed OAuth refresh/revocation is not a substitute for immediate blocking of new application authorization decisions. Already downloaded bytes, in-flight responses and third-party previews cannot be recalled.
- Management/OAuth/MCP and artifact delivery need separate origins; publication credentials must not be exposed to the artifact origin. Exact final infrastructure names belong to F09 and are not reserved by this spike. The bounded F04 domain exception remains F04's decision, not an F06 configuration change.

## Runtime capacity and billing evidence

The existing Workers Paid subscription was observed at USD 5 per month; no plan or billing upgrade occurred. In the aggregate GraphQL window containing the operator 16 MiB control, the success group reported CPU p50/p99 `692740` µs and wall p50/p99 `1394875` µs. The query did not establish full sampling/ingestion coverage or isolated per-file attribution; these figures are not a global maximum, headroom guarantee, effective CPU limit, or end-to-end transfer duration. The operator control's matching hashes establish the observed transfer, not production capacity.

## Protected evidence index

The following are protected receipt **basenames** and SHA-256 digests; they are not credential stores. Earlier receipts describe the state at their own observation time and are not rewritten by later successes.

| Receipt | SHA-256 |
|---|---|
| `F06-native-codex-positive-20261113T193814747580Z.json` | `d14f9365ff50478e95ff8f3e2ba7381bc3f0201fa6d443e5fbbc0104e96cd593` |
| `F06-native-codex-refresh-positive-20261113T195010836631Z.json` | `680aa64895f89a8df143ae2593a35e9c53979668ef3acbbf81022cc648f83119` |
| `F06-native-codex-denial-positive-20261113T211504816898Z.json` | `f5e57b285ed9617ec21554c3814b57ac7290c285f03ac8fac12c5a86710a0068` |
| `F06-native-codex-regrant-positive-20261113T213405602958Z.json` | `51690aa927c8e1e17f929c39937172a37a9c74074b784cd3b39c443a49b97484` |
| `F06-native-omp-matrix-complete-20261113T235027067739Z.json` | `30db95d9a5418ad4d0dddfa1a21d03fe9ec0c82568b4a014bd18b9dafe205049` |
| `F06-native-claude-matrix-complete-20261114T085802689357Z.json` | `4039c613b7f433e730d890c73ed14a89a8ea47ae1c30a50a438773069e5b25bd` |
| `F06-native-claude-protocol-observed-20261114T093627590601Z.json` | `2f6f5c63f3d786a41847a914c00815852f524f15cb8c2650850aee9972cf2b5d` |
| `F06-native-codex-protocol-observed-20261114T093627605565Z.json` | `dbf72461acf5ddff807d6855f785c24bd6ac57a2fe1586dc71cf26e51dbf8488` |
| `F06-native-omp-protocol-observed-20261114T093627607468Z.json` | `b0f61173eaa9de7c8e771ce788fda1be4047eacf3b7395dc4f7570f69738df8d` |
| `F06-wrong-verifier-rejected-20261113T193133741034Z.json` | `f9bf666e76e9c6e4892a98dd47d0e5b5787ff9b95c5980d99389fe0eb2e3da05` |
| `F06-wrong-resource-rejected-20261113T194624418169Z.json` | `d89a843be7beb606791c0d2c4184dfc66ee7b3562c71362dd36401b2207244bb` |
| `F06-boundary-result-1794605522193.json` | `9ae1e54e48e0e8beddaf0c63f045d3cfd2adbd242804ff6a1e899d20542195cd` |
| `F06-remote-mcp-roundtrip-1794606561665.json` | `6a6bfc6d786d7e02442676b244fe47726d6e25ed8ee0ec1715e4967de5ccf21b` |
| `F06-workers-plan-readonly-20261113T214453033082Z.json` | `d95e34f59eec8d0b7912affd58cac62a58fef6dc8d7cee40ea88e28219e07ce0` |
| `F06-revocation-window-1794607264317-complete.json` | `1b21c3946f862ef45bd7aa960f08d652236e9f35b661fd996988cda6ef404f14` |
| `F06-two-certpacks-explicit-retirement-approval-20261114T100756980986Z.json` | `f215fe4dc2e55e18676c01c118291b8623bcc08088dcaa29279a24efb5549e86` |
| `F06-owned-retirement-readonly-1794652914841-852202.jsonl` | `a3ec273381df6dce21407d5a9e58f0899ca3110882733f8410a0501b18e062d3` |
| `F06-owned-retirement-execute-1794653018423-1093510.jsonl` | `43271e2ac8a53cfc9e76ab221fa01f5c0826692a5278448239cc53be656a652a` |
| `F06-provider-detached-checkpoint-readonly-20261114T105405Z.json` | `d679e53906342a3b1f8aeab4c5b082082b31a73d42b6ad11e38a94712b715499` |
| `F06-public-tls-after-domain-detach-20261114T105258221659Z.json` | `3636ed997a1c0643152d3c1f8cd216c3a880833c8927115588b8eb5df1668777` |
| `F06-owned-retirement-execute-1794654100545-2713735.jsonl` | `dbba7db72a517f74c7d047dda9e4b32181f995434fcf659cc93bcbe317e9c782` |
| `F06-public-tls-after-owned-retirement-20261114T110746439865Z.json` | `8075d78755432277489bb59934cfc10670d1a7e9119698d11c1474dd3de2d1a7` |

## Owned-cycle retirement and acceptance

1. **Observed cloud closure:** after an independently reviewed procedure and passing read-only preflight, the operator detached the two owned domains at 10:44:26 and 10:44:31 UTC on 2026-11-14. The first execution stopped at DNS readback on `inconsistent page count`; the API returned page 1, per-page 50, zero count/total and one total page, while the parser incorrectly expected `ceil(0/50) = 0`. The subsequent read-only checkpoint found no owned domains or exact-name DNS, with both Workers and apps still present. An earlier read-only zone-pagination stop had been resolved without mutation as `extraPageAfterTotalComplete`. After fresh review, explicit continuation deleted the two owned Workers and two owned Access apps, and completed at 11:04:34 UTC. Final readback found both domains, Workers and apps absent, zero records for both exact DNS names, and both previously app-scoped non-reusable policies returning 404 with no residual policies. Access was preserved until the serving endpoints were gone. The original receipt records the two domain deletions; the continuation records only the two Worker and two app deletions. No direct policy, DNS or certificate deletion, or shared identity/legacy mutation, was performed.
2. **Certificate disposition — observed, not attributed:** final provider readback preserved all six baseline packs and their recorded leaf IDs. Exact GETs of the two owned packs returned `deleted` for both packs and their leaves, with matching host provenance. No certificate DELETE was issued by the operator or agent; its cause is unknown, not proof of automatic cleanup. The separately authorized manual certificate-retirement phase was not executed, and its necessity for this run was not established. Unauthenticated TLS-verified HEAD requests after full retirement returned HTTP 200 on two existing origins with certificate fingerprints unchanged from before detach; this does not establish authenticated ACLs, shortlinks or all TLS consumers.
3. **Acceptance:** the completed technical evidence and cloud readback do not themselves constitute final acceptance. Independent review and required CI must cover the final SHA, followed by merge; consult PR #8 and the project ledger for live status. The historical NOT CLEAR reviews and earlier root CI do not substitute for these gates.
