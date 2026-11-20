# Manage HTTP publication API

This JSON and streaming interface is implemented by the separate [manage Worker](../adapters/http/manageWorker.ts). It composes Catalogue authentication, Publication and Revision Store; it is not a second authorization or publication engine. The [core contract §9.3](forge-core-contract.md#93-publication-commit-composition) owns the publication and commit semantics.

**F04 is a release candidate, not yet merged or delivered.** On 2026-11-16 the operator stopped the blocking synthetic capacity campaign in favor of delivering the usable engine, deploying it and then performing the approved cutover. Final-SHA independent review, required CI and functional integrity/authorization evidence remain required. The actual isolated-cloud smoke on runtime `10e4022a74340170556fb2c1104bf70bbaee643f` completed creation and update with a 32 MiB asset, including server materialization, independent D1/manifest reconciliation and physically hashed R2 bytes. Joint maximum cloud capacity and numeric memory peaks are **not proved**. This is neither a permanent 32 MiB product cap nor permission to exclude larger selected files; support and verification remain required before their migration. No production cutover or additional Cloudflare permission follows from this delivery-policy amendment.

## Endpoints and commands

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/publication` | UTF-8 JSON command; no query parameters | Full status, small file acknowledgement, receipt or `null`, according to operation |
| `PUT /api/publication/upload?sessionId=<encoded>&path=<encoded>` | Raw file bytes | Small file acknowledgement |

Paths are exact: there are no trailing-slash aliases. The upload query has exactly one `sessionId` and one `path`, with no other names. Encode with `URLSearchParams` or equivalent: a literal `+` must be encoded. The Worker decodes selectors once and passes the resulting path unchanged to Publication. Selectors identify a session and resource; they are not authorization capabilities.

The POST body is exactly one of these envelopes, with no additional fields:

```ts
{ op: 'begin', command: BeginCommand }
{ op: 'materialize', sessionId: string, path: string }
{ op: 'seal', sessionId: string }
{ op: 'commit', sessionId: string }
{ op: 'status', sessionId: string }
{ op: 'abort', sessionId: string }
{ op: 'restore', command: RestoreCommand }
{ op: 'unpublish', command: PromotionCommand }
```

The authoritative command and result fields are in [Publication types](../domains/publication/types.ts). Every request DTO field is required, including explicit nulls; unknown request fields are rejected. Integers must be finite safe integers. Metadata may be any finite JSON value within the body and depth bounds. Publication retains semantic validation, ownership, current authorization, idempotency and promotion. Clients ignore additive response fields; removing a field or changing its meaning requires a versioned contract change.

Typical flow: `begin` → upload client files and `materialize` each retained base file → `seal` → `commit`. `status` reports staging progress; `restore` promotes a retained revision and `unpublish` performs the guarded metadata transition. `abort` returns `null` after the domain operation, including its deliberately indistinguishable no-op cases; an authenticated owner can close their own session even after revocation. It is not an implicit disconnect action.

POST requires `Content-Type: application/json`, optionally `charset=utf-8`. PUT requires `application/octet-stream` without parameters; the resource's content type comes from its manifest, not this header. Content-Encoding must be absent or `identity`. A missing PUT body means zero bytes; a nonzero declared Content-Length with no body is invalid. JSON requires a body.

## Selected import
### Local selected-input planner

The offline adapter has two commands and no apply mode:

```sh
node scripts/forge-import-offline.mjs prepare --selection /private/selection.json --workspace /private/new-workspace --capture-root capture=/private/capture
node scripts/forge-import-offline.mjs plan --workspace /private/new-workspace
```

`prepare` requires a new workspace path and one `--capture-root alias=/absolute/directory`
per declared root; the option may be repeated. `plan` accepts only the workspace:
it cannot replace the selection or capture roots. Unknown flags are rejected.
The selection is a private JSON document, not a discovery request. Its version 1
schema includes instance/evidence identifiers, declared transport and inventory
limits, the reader projection (canonical and alias hosts, route/share grammars,
share-cookie setting and shell paths), capture-root aliases, explicit entries,
pages, owners, aliases, shortlinks, previews, consumer URLs, exclusions and provider
mounts. See the synthetic [selection fixture](../tests/engine/fixtures/import-selected.mjs)
and [translator](../scripts/forge-import-selected.mjs) for exact required fields.
Every entry has a logical path, classification, content type, provenance,
`locator: { root, relative }`, and an `expected` fingerprint. Content requires
`{ size, sha256 }`; shell, excluded and unresolved entries may use `null`.
Each page's `membership` and each content entry's `placement` identify the
original source artifact and its evidence reference; non-content and unresolved
entries use null placement. Consumer observations identify their expected target
page or mapping as well as their purpose.
Reserved non-content paths still require explicit exclusion evidence and are
not opened. The root is an alias supplied on the command line; the path is
relative to that root. Actual content bytes are independently observed and
compared with both expected fields. Missing, unreadable, mismatched, protected
or escaping paths are not substituted.
Selection and checkpoint JSON are decoded as strict UTF-8 before parsing;
malformed bytes are rejected rather than replaced, and a leading BOM is rejected
by JSON parsing rather than silently removed. Logical paths and relative
locators must be well-formed Unicode scalar strings; the original spelling is
not rewritten. Capture paths are not R2 keys: the compiler allocates bounded
ASCII source and inventory keys. A private entry-ordinal fact retains each valid
original locator component and uses null for an invalid component. A valid root
alias spelling may be unbound; executable read and protected locators require
both valid strings and a declared root.
Its unit and logical path join to the sealed member's source reference and native
version. Planning uses the pin, not a capture reread, and receipts do not disclose
locators.
Treat the selection, workspace and its capture evidence as sensitive: share keys,
destinations and protected inventories can be present there.

Node 22.12 or later is required. The offline CLI bundles the fixed repository
translator and Catalogue parser in memory using the existing toolchain; it
does not require Node's experimental TypeScript loading. Selector, workspace
and state use the shipped private descriptor checks, including effective access
checks rather than mode bits alone. All candidate and explicitly protected
locators are resolved across root aliases and their available physical identities
checked before the first body read. Descriptor metadata inspection is not a body
read; identities are checked again when bytes are read. The authorized read and
protected-locator sets are not complements: omission of ordinary content from a
blocked unit does not make its inode a protected exclusion.
Reservation checks every capture-relative component using a conservative
NFKC, case-folded and default-ignorable-character-stripped comparison for
`.env`, `.env.*`, `.git` and `.ssh`. This deny-only comparison may reserve extra
names and is not a specification of all filesystems or proof of APFS behavior.
It never rewrites the descriptor path or publication identity. Protected metadata
and cross-alias physical identity checks still precede all body reads.
An overlong ordinary component is unreadable, not absent; an inability to resolve
protected metadata refuses preparation before any body read.

Before body reads the selector groups declarations by artifact. Evidence slots
retain candidate unit sets and declaration multiplicity; a rejected or ambiguous
relationship is not an admitted owner or operation. Admitted relationships
establish governance and local edges. A rejected but otherwise sound request
for an unknown external tree resource can still explain a missing dependency;
claims on known documents or subdocuments and impossible subtree claims cannot.
A subtree owner must be local to its artifact and under its exact subtree prefix.
Native import admission independently checks the structural distinction.
The compiler completes artifact-local drafts and their intrinsic checks before
comparing viable drafts for global conflicts.
All participants in a genuine conflict are blocked.
Surviving drafts contribute routes, placements and aliases to one frozen proposed
read view; a failed consumer or later pin failure does not select another winner.
Each page needs its canonical primary address in the selected reader profile.
An unconstructible canonical HTTPS origin is a global `invalid_grammar` refusal
before capture binding; a constructible origin with a disabled primary route
remains a unit-local refusal.
A subdocument requires an evidenced subtree in its own artifact. HTML roles use
the validated media-type essence while preserving the literal Content-Type;
an asset cannot be HTML. This view is neither a live route nor access proof.

The preflight keeps an indexed census, including malformed relationships.
An unassignable contradiction is a fatal selector failure, distinct from a
valid exclusions-only selection; projection preserves a fatal receipt without
inventing projectable facts. Each ordinal's affected units come from its
kind-specific semantic relation and remain the same on normal and fatal exits;
ambiguous references retain all independently evidenced candidate units without
choosing a winner. Mapping-only attribution survives an unrelated fatal record. Raw invalid identities
do not become unit IDs; JSON-safe evidence is the same census checkpointed and
authenticated in the receipt. Each attributed missing or unreadable member
blocks its complete source artifact; independent units may still proceed. The ID
ledger scopes identity by canonical serialized source tuples, including source
instance and original artifact. Emission and replay use the same tuple validation;
noncanonical or malformed keys, including non-scalar paths, are rejected rather
than reminted. Private member facts retain ordinal, stage and
reason, including distinct diagnostics for the same member. A projected source
failure must name an ordinal authorized for source observation.
The per-unit dependency list retains each required provider's path and kind.
For contradictory local/provider evidence, the rejected provider ordinal retains
the valid declared ID and `provider_local_placement_conflict`; the foreign
claimant's dependency is `missing` with a null ID, not `unverified`, and the
local claimant has no dependency. Other valid provider declarations may be
unverified; none establishes an active mount. Invalid provider IDs retain their
rejected ordinal and identifiable dependents. An empty dependency list means
no identified dependency, not an inference from a blocked unit.

Private unit budgets retain known declared file, page and edge counts, largest
file size and all known breached dimensions even if a unit cannot compile.
The `commandBytes`, `envelopeBytes` and `inventoryBytes` measurements are null
until a draft is serialized; afterward they are actual measured bytes, not
fabricated zeros. The envelope measurement uses the maximum-cursor convention.
Draft inventory bytes do not predict the later pinned inventory size, which is
checked separately after native source versions are assigned. These diagnostics
are not a historical capacity benchmark.

Unknown or unreadable policy capture blocks its unit, whereas an observed
unrecognized visibility value is retained for the native warning. Static
recognition, representation by an eligible unit, native `ready`, and actual
consumer HTTP authorization are separate outcomes. Literal shortlink destination
preservation does not prove the target, key or grant association; a dry-run
does not prove an actual consumer HTTP response.
A valid team-only alias to `/` can be stored without proving that its destination
is a selected document. Alias keys and destinations containing literal `%25`
are rejected before readiness because Catalogue route storage forbids them.
Required consumer claims must resolve to the actual
winning selected resource and purpose; a share or card destination additionally
requires the exact captured key and observed shared visibility. A team alias
does not authenticate its destination. Excluded census names are not primary
mounts and cannot by themselves shadow an alias; selected routes and eligible
resource placements determine precedence, including placed assets with no owner
edge. A non-null shortlink grant must be a valid catalogue grant ID and be
produced by a validated proposed shared policy on that page anywhere in the
full admitted inventory, regardless of cursor window or operation order, or
exist on that page in D1. An existing revoked grant can satisfy this referent
check: existence
is not active read authorization, and dry-run does not prove consumer access.

Preparation creates isolated local D1 and R2 state, a synthetic administrator and
signing material, then pins native object versions and a separately approved
inventory. Planning reopens those pins, authenticates to the actual manage Worker
and consumes its bounded dry-run continuations. It does not apply, publish,
discover providers, use a host provider transport or claim operating-system
network isolation. Expected source reread failures and late inventory byte-budget
failures block the affected unit without invalidating independently sealed units;
one atomic private checkpoint records the resulting outcomes. This is not a
crash-recovery guarantee. Private member failure facts retain the entry, affected
unit, stage (`inspect` or `pin_reread`) and reason. An observed absent
public/shared page document also reports OR-1 at that stage; an absent stylesheet
or an unreadable file is not evidence of that missing-document condition. Public
receipts expose fixed codes and counts, not member paths, page IDs or other
private evidence. Planning groups no more than 1,000 approvals per
Worker binding and uses a fresh fixture assertion for each unit's planning
window without extending native cursor expiry. The nonsecret receipt
distinguishes fatal, exclusions-only and partial preparations, and reports
compatibility separately from each native `ready` or `blocked`
outcome. Warning codes and counts are sanitized through a public allowlist;
unknown codes use a fixed category, and private values are not emitted. The
receipt compares logical database contents and both bucket inventories before
and after completed runs. If dispatch, decoding or continuation is interrupted,
store equality is unknown unless the after-snapshot completes.
A ready unit does not resolve an `or1_missing_document` blocker in another
selection, activate a provider, or establish historical fidelity or F10
acceptance. G1b is closed only for the verified capped historical ownership
graph; Claude native publication is deferred and no private operation grant
is active. Historical execution requires separate current authority and evidence.


`POST /api/maintenance/import` is a separate, administrator-only interface for
an operator-approved selection, not an arbitrary source or SQL API. It accepts
exactly one of the following JSON envelopes; `command` is the normal
`BeginCommand`, and all selection fields are required:

```ts
{ op: 'dry_run', selection: { version: 1, inventoryId, selectionId, planId, command }, cursor: null | string }
{ op: 'apply', selection: { version: 1, inventoryId, selectionId, planId, command }, cursor?: null | string }
```

The optional import configuration consists of the private R2 binding
`FORGE_IMPORT_SOURCE` and the JSON string `FORGE_IMPORT_INVENTORIES`; provide
both or neither. The latter is a nonempty array of at most 1,000 operator-pinned
approvals, unique by `inventoryId` and `selectionId`. Each approval has exactly
`inventoryId`, `selectionId`, `sourceInstance`, `objectKey`, `objectVersion`,
`sha256`, `approvalRef`, `kind` (`synthetic` or `historical`), `g1bRef` (string
or null), and positive `maxInventoryBytes`. The digest is lowercase SHA-256.
The protected inventory pins the selected graph and each source object's
native version, size and SHA-256; the caller cannot supply the source path,
approval or metadata in place of that inventory. See the
[inventory types and admission](../domains/catalogue/import.ts).

To prepare an inventory, capture the approved source instance and artefact,
page-to-route and ownership evidence, graph edges, each client file's private
object key/native version/length/SHA-256, and the selected policy, alias,
shortlink and original-preview observations. The inventory and its exact
Publication command must describe the same selection. Protect it with its
private source objects, then pin its own R2 object key, version and SHA-256 in
the operator configuration above. Approval and evidence references are not
proof by themselves: historical key and destination provenance must actually
be established. G1b was lifted only for the verified capped ownership graph.

For an existing target, include the complete retained base graph: kept pages,
their resources and ownership edges. Omitting a base resource or edge does not
authorize deletion. Intentional removals belong in the protected inventory's
`removals` list as typed `resource` or `edge` entries with an `evidenceRef`;
edge entries also identify owner, path and provider artefact. Existing
unselected original preview selections must remain owned base resources.
Derived-only kept previews that cannot be carried forward block the plan,
rather than triggering a silent regeneration or fallback.

Aliases use Catalogue's same-origin redirect grammar and are team-only routes;
the importer does not change configured route grammars or manufacture cookie
credentials. Existing share cookies remain subject to the configured cookie
policy and the current live grant. Shortlink observations are protected
metadata; import does not call a provider or retarget a destination.

Dry-run requires a currently established administrator and makes no publication
writes. It may return `checking` with a continuation cursor, `blocked` with
issues, or `ready` with plan, source and target digests. A ready result is an
observation made during that run, not an atomic snapshot of the current source,
a promise that its objects remain available, or permission to apply. The
inventory's pinned version and digest are rechecked on each request. Plan and
source identities use separate domain-separated HMACs: the plan binds the
selection and exact approved inventory pin, and the source digest binds the
file descriptors. Neither exposes raw keys, destinations or an unkeyed digest
of protected inventory. Existing sessions select their original plan identity
from the retained verifier-key ring; new plans use its primary key.
The continuation is signed and binds the operation, instance, current
administrator and authority epoch, plan, phase and expiry. Target observations
remain keyed under the verifier key selected when the continuation starts;
new cursors are signed with the current primary key. Retaining the original
plan and observation keys across rotation permits unfinished checks and
sessions to continue; removing either required key prevents reconciliation.
Cursor MACs are verified against their indicated retained key. The cursor is not
a credential or authority to activate. Expiry or a changed actor/plan requires
restarting an unfinished check; a committed receipt can be reconciled with fresh authority
after cursor expiry while its plan key remains retained. Apply can return `checking`
before staging; pass its `nextCursor` to the next apply request and continue
staged responses with their `nextCursor`, or resume an existing session without
a cursor.

Apply reauthenticates and uses normal Publication staging, streamed byte
verification, sealing and activation. Each source read must match the approved
native version and the declared size and SHA-256; an unavailable or changed
source is reported as `blocked` with `source_integrity` and its path, never
replaced by latest bytes. Staging can span requests and leave inert bytes on
failure; publication activation,
selected metadata and import receipt are guarded together in the owning D1
transaction. Replaying the same plan reconciles the recorded result, rather
than implicitly creating a new publication or rotating a share key.

Each transfer step admits at most eight files and 32 MiB in total; an individual
client or base file larger than 32 MiB is blocked. The session binds the plan
to its initiating actor, authority epoch and configured TTL. Resume with the
same plan and current authority while the session is open; a closed session
requires a new plan identity. These limits are import-step limits, not a
general Publication size limit or a cloud capacity claim.

At activation, the shared Catalogue guard rechecks that every external
ownership edge still names a live fragment or asset mount of its provider.
A provider unpublishing that resource after preparation makes activation
conflict; local edges remain governed by the selected revision. This applies
to ordinary Publication as well as import, not only to dry-run.

The request deadline includes metadata inspection and byte transfer. Each
guarded transfer write checks the deadline immediately before D1 dispatch; no
new write batch may start after expiry. A D1 write already submitted cannot be
cancelled and may settle after the deadline; its outcome is awaited.
Finite visibility or shared-key expiries are explicitly blocked as
`expiring_policy_unsupported`: the current target policy cannot preserve
their expiry without extending access. Historical execution remains unauthorized
without separately approved selection, protected inputs and target basis. This interface adds
no backup/recovery system, collection scheduler, production migration or
historical-fidelity claim.

## Request-driven previews and sharing

After commit, the adapter awaits a best-effort enqueue of lightweight OG
intents in bounded batches before responding. It does not render or change the
publication receipt. An enqueue failure can leave a partial set while the
successful receipt is still returned; an authorized replay of the same commit
can repair it while that revision remains current. `forge_enrichments` is a
read-only, freshly authorized status query.
`forge_retry_enrichments` explicitly admits pending or retryable failed work
for the specified page, revision, content version and policy epoch. If no OG
job exists for that page and revision, an explicit OG retry can create the
lightweight intent for a previously committed, currently authorized target in
the same guarded transaction. It never replaces an existing stale or terminal
job, nor reconstructs missing shortlink information. All requested kinds must
be admissible or the transaction rolls back. Expired attempts may be reclaimed,
but an unexpired lease is not reset. Execution uses the authenticated actor
and the exact admitted job. There is no cron scheduler.

Optional management Worker settings:

| Variable | Purpose |
|---|---|
| `FORGE_BROWSER_ACCOUNT_ID` | Cloudflare account ID for the fixed Browser Run screenshot API |
| `FORGE_BROWSER_API_TOKEN` | Secret with Browser Rendering Write permission, used only in the control request authorization header |
| `SHLINK_API_URL`, `SHLINK_API_KEY`, `SHLINK_DOMAIN` | Optional HTTPS Shlink collection URL, secret API key and short domain for newly minted share enrichment |
| `FORGE_SHARE_SEAL_KEY` | Optional share-sealing key required for a newly minted share to be revealable and eligible for automatic shortlink enrichment |

Missing or invalid Browser Run configuration leaves publication usable and
explicit OG execution unavailable. The adapter supplies the admitted revision
graph as inline content and injects no management cookies, bucket credentials
or management URLs. Its early CSP and request filters bound remote imports;
HTML authors are trusted, and this is not a hostile-content or all-protocol
sandbox. Rendering, input and output are bounded; failures do not reverse a
publication or overwrite an existing original image.

Automatic shortlink enrichment requires valid Shlink configuration, a freshly
minted revealable share and a current eligible revision. Without a sealing key,
the primary share still works, but the adapter creates no shortlink intent:
there is no pending shortlink job to retry, and adding a sealing key later
cannot reconstruct the original key. Provider errors do not undo the share.

Shlink creation is create-only. Reconciliation checks the exact provider,
domain, code and destination; publishing, retry and grant rotation do not
retarget existing or imported aliases. Actual destination URLs can contain
share keys and are protected metadata, not ordinary status output.

Native transport regressions construct Worker `Request` objects with simulated
providers; they do not prove a real Browser Run or Shlink call. Visual screenshot
fidelity and actual provider configuration remain unverified.

This request-driven path adds no autonomous recovery service or advanced
backup/restore guarantee. A timed-out derived write may leave unselected bytes;
selection still requires the current lease, target and graph assertions.

## Authentication and origin

Configuration, effective HTTPS URL origin and any literal Host header are checked against the configured management host before authentication. Forwarded host and Referer are not trusted. Host and Origin checks precede Catalogue's possible principal self-registration. Route, method, selector and framing checks also precede authentication; authentication precedes reading or parsing either body.

- If `Origin` is present, it must exactly equal `https://<manageHost>`, including for assertion-header requests. Empty, `null`, joined, read-origin and other values are refused.
- Without Origin, any Cookie header is refused. Native mode requires a nonempty `Cf-Access-Jwt-Assertion`; if `Sec-Fetch-Site` is present it must be `none`. Native clients must not send a cookie jar in this mode.
- With the exact Origin, Catalogue can authenticate the Access cookie or assertion. An assertion takes precedence and a bad or empty assertion does not fall back to a cookie. A share cookie is not a management credential. An `Authorization` bearer alone is not interpreted by this Worker; Access supplies the signed assertion after authenticating its client.

Catalogue verifies the Access JWT and obtains keys only from the configured Access team certificate endpoint. Its outbound JWKS request uses manual redirect handling and rejects non-success responses, including redirects; it never follows a redirected key source. See [identity.ts](../domains/catalogue/identity.ts).

Catalogue performs target-bound preparation authority checks before private namespace/base/revision verdicts. A scope on an unrelated page is not authority over the requested artefact. The worker uses the shared [manage-edge](../adapters/http/manage-edge.ts) admission/error primitives; it implements no second role policy.


## Bounds, streaming and recovery

Content-Length, when present, must be one nonnegative decimal safe integer and must not exceed the configured cap. Actual bytes are counted even when length is absent or misleading. JSON is read with a deadline, decoded as fatal UTF-8 and checked for finite values and configured nesting depth. A `begin` file larger than `maxUploadBytes` is rejected whether its source is client or base.

Uploads are pull-driven without buffering the entire file or hashing it in JavaScript. Store counts actual bytes and uses native `crypto.DigestStream` plus R2 checksum verification, retaining the last byte until clean EOF and digest verification. Publication owns its upload deadline. An interrupted open body errors the stream without implicitly aborting the session. Reconcile uncertain disconnects/lost replies with `status` and the same idempotency key. A verified file retry after seal/commit checks fresh authority and performs no new write; new writes after seal reject. Native cancellation does not prove physical provider rollback; see [core §9.3](forge-core-contract.md#93-publication-commit-composition). Visibility/share changes may allow ordinary live-page byte staging to continue, but commit rejects stale policy epochs. A principal authority-epoch change, including a new role grant, requires a fresh session and key.

## Responses and errors

Success is HTTP200 with `{"ok":true,"result":...}`. `upload` and `materialize` return only `{sessionId,path,stored:true,state}`, where state is the real `open`, `sealed` or `committed` snapshot. They never return all session files. `begin`, `seal` and `status` return full status: `sessionId`, `artifactId`, `revisionId`, `baseRevisionId`, `expiresAt`, `state`, and `files` entries of `path`, `source`, `stored`. A receipt contains `artifactId`, `revisionId`, `contentVersion`, and `pages` entries of `pageId`, `url`; URLs are relative paths. Abort returns `result:null`.

Errors have the fixed shape `{"ok":false,"error":{"code":"..."}}`; no exception detail or credentials are returned.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Invalid JSON, UTF-8, shape, depth, selector or framing |
| 401 | `unauthenticated` | Missing or invalid management identity |
| 403 | `forbidden` | Host, Origin or policy refusal |
| 404 | `not_found` | Unknown route or unavailable resource |
| 405 | `method_not_allowed` | Known route with another method; `Allow` names the supported method |
| 408 | `request_timeout` | Command read deadline, Publication-owned upload deadline or observed interrupted body |
| 409 | `conflict` | Idempotency, version or storage conflict |
| 409 | `last_admin` | Last-administrator protection; shared classifier, no role endpoint added by F04 |
| 409 | `upload_incomplete`, `not_sealed`, `session_closed` | Corresponding publication state |
| 410 | `session_expired` | Session expired |
| 413 | `payload_too_large` | Configured byte cap exceeded |
| 415 | `unsupported_media_type` | Unsupported media type or encoding |
| 422 | `invalid_state`, `integrity_error` | Invalid domain state/input or a typed Store integrity error |
| 500 | `internal_error` | Explicit invariant violation |
| 503 | `configuration_error`, `unavailable` | Invalid configuration/instance mismatch, or unavailable/unclassified operation |

Actual input size/digest mismatch is a typed422 integrity failure; unknown native provider/producer failures remain503. The classifier never infers causes from provider prose. HEAD returns the same status and headers without a body. Every response has `Cache-Control:no-store`, `X-Content-Type-Options:nosniff`, `Referrer-Policy:no-referrer`, JSON content type and `Content-Security-Policy:default-src 'none'; frame-ancestors 'none'`. There are no CORS allow headers, redirects or successful preflight.

## Trusted configuration and local profile

The server requires a D1 `DB`, private R2 `REVISION_BYTES`, and the whole validated `FORGE_INSTANCE` and `FORGE_SHARE_VERIFIER_KEYS` JSON configuration; `FORGE_SHARE_SEAL_KEY` is optional. See [instance configuration](forge-core-contract.md#4-instance-configuration-s1) and the [parser](../domains/catalogue/instance-config.ts). Management host is distinct from read hosts; `.workers.dev` and `.pages.dev` hosts are forbidden by the core contract.

Two additional required JSON **strings**, with exact keys and safe integer values, have no defaults:

| Variable | Required keys |
|---|---|
| `FORGE_PUBLICATION_OPTIONS` | `sessionTtlMs`, `maxUploadTimeoutMs`, `retainMs`, `marginMs`, `manageClockSkewMs`, `readClockSkewMs` |
| `FORGE_MANAGE_TRANSPORT` | `maxCommandBytes`, `commandReadTimeoutMs`, `maxUploadBytes`, `maxJsonDepth` |

Transport values must be positive; `maxJsonDepth` is at most 64, and command and upload timeouts must fit the timer range (at most 2,147,483,647 ms). The Publication constructor enforces positive session/upload durations, nonnegative skews, retention of at least 900,000 ms plus both skews, and margin of at least the upload timeout plus both skews. Safe arithmetic and a matching Store instance are required. Invalid configuration fails closed with `503 configuration_error`. Values must be selected from an independently measured deployment profile; test values are not production defaults.

The domain's10,000-file/1,000-page/20,000-edge ceilings are unchanged, but an actual serialized command must also fit the explicit transport profile. A32KiB test setting cannot admit a10k-file begin. These validation ceilings and a successful32MiB smoke are not evidence of joint cloud capacity, native batch duration or memory headroom. The operator removed the bulk campaign as an F04 release gate; do not reinstate it implicitly or describe an uncompleted run as a pass. Deployment profiles still need to support the selected corpus and fail closed at their declared bounds.


Immutable runtime dependencies are cached in a WeakMap per actual environment object, including Catalogue's JWKS cache. Actors, roles, epochs, authorization decisions and receipts are not cached; each accepted request authenticates anew and domain operations consult current authority.

[`wrangler.manage.toml`](../wrangler.manage.toml) is **local development only: do not deploy it**. Missing remote identifiers can cause Wrangler to auto-provision real D1/R2 resources on deploy; `workers_dev = false` and `preview_urls = false` do not prevent that. Do not add fake IDs to imply safety. Its compatibility date is `2025-02-14` with `enable_request_signal` and `unhandled_rejection_after_microtask_checkpoint`; the latter applies standard checkpoint timing, not suppression of genuine unhandled rejections. It has no deployment approval or production values.

## Local evidence and boundaries

The following commands target the current engine typecheck and the isolated HTTP and native-JWKS projects:

```sh
./node_modules/.bin/tsc -p tsconfig.engine.json --noEmit
./node_modules/.bin/vitest run --project manage-http tests/engine/manage-http.security.test.ts tests/engine/manage-http.publication.test.ts tests/engine/manage-http.config.test.ts
./node_modules/.bin/vitest run --project native-jwks tests/engine/native-jwks.test.ts
```

Historical candidate `6de673e523c6211c9781d544f97058b1d3ce1c5b` passed32 tests across four files. Its separate local socket exercise used the actual default Worker, native JWKS, D1 and R2: after a disconnected upload the old snapshot remained selected, and retry produced the expected content version, exact bytes and native SHA. Those inputs exclude the subsequent corrections, whose separate proof is below. No local observation establishes Cloudflare capacity or deployment proof. Native EOF/internal asynchronous diagnostics occurred in failure tests; this does not classify every diagnostic as harmless or resolved.

Subsequent review corrections were exercised by TSC and36 targeted Store/publication-HTTP tests, all passing, after the earlier complete engine run reported271/272. This is not a claim of a fresh complete-suite pass. The corrected physical socket then passed with the exact21 compiler-consumed source hashes, bundle hash, migration bytes and bracketed profile/parser hashes recorded. Its runtime-observer counters were zero only within the declared coverage. Failure-path native pipe/connection/uncaught diagnostics remain visible in unit output; no filter or universal harmlessness claim is applied.


The F04 evidence above adds no MCP business-client proof or GC scheduler and predates the selected-import maintenance endpoint described above. It does not prove a legacy URL or Shlink production change. Real three-client business publication belongs to F08; further cloud operations require separate approval.

### Post-review contract corrections — 2026-11-14

- Historical restore refuses full-path drift of an already live page with generic422 `invalid_state`; `restore_path_changed` stays an internal detail, not a new public DTO. Explicit unpublish/drop then restore recovers the historical route and page ID privately, with a new policy epoch and no old-share revival.
- Committed restore/unpublish receipt replay validates the current principal and roles before the recorded epoch: a freshly revoked actor gets403; an otherwise authorized recorded-epoch change or already stale handle remains409. Upload/status retain their separate session-epoch check; these rules do not promise identical error precedence at every endpoint.
- Only the unique owned deadline cause maps to `publication_upload_timeout`. A genuine prior native failure retains its class after a later timer; a confirmed sealed winner is reauthorized and reconciled before timeout translation. Native regressions separately exercise the post-put conflict branch and a real `StoreError.cause === signal.reason` timeout with an independently completed seal; actual HTTP still returns the owned408 for a genuinely stalled producer.
- Inventory failures retain distinct ownership: malformed native Store descriptors are `integrity_error`; a well-formed inventory that does not prove Publication's declared revision set is `invalid_state`. Both are422 and fail closed, with no activation, replacement bytes or invented provider checksum.

The complete0a80726 CI tree passed309 Vitest/205 Python tests. Later local corrections passed their separate source-bound checkpoints; neither statement is a final-SHA acceptance or cloud-capacity claim.

### Second review corrections — 2026-11-15

- Restore requires a prior successful Publication commit for the exact instance/artefact/revision, checked after current authority and in the atomic event. A sealed-but-never-committed candidate returns generic422 `invalid_state`, not a new public error code. Missing/discarded targets precede drift checks. Refusal changes no routes, mounts, events, version or rights; it neither deletes staged bytes nor poisons a still-open session's own commit. Imported origin alone is not commit history; F10 must supply vetted durable history and F11 must preserve it.
- `begin` refuses both keep and drop of a tombstoned page as404 before creating a session. Explicit restore retains its existing global-authority/readmission rules. Status projections omit unused file/page metadata without changing this DTO.
- Targeted parent verification: both TypeScript projects pass; the four-file run passed48 cases and failed six new race fixtures before their business path because bootstrap was called twice. Removing that duplicate setup, without changing runtime or weakening bootstrap, gives6/6 native race cases passing. This is a composite checkpoint, **not** a new complete-suite run. It includes11 restore cases, three causal deadline cases,31 HTTP publication cases, native inventory/audit/cost cases and both barriers of each non-selected-page race.
- Historical candidate `02ec355da6ab1b2c5549aa99406eb7e1bb670772` separately passed actual required CI353 Vitest/205 Python with a verified identical CI merge tree, but its independent reviews found the corrected defect and missing race evidence. That CI/review does not approve later changes. The current runtime and cloud-smoke evidence are identified at the top of this document and in the delivery status; final-SHA review/CI and separately approved production operations remain gates.

