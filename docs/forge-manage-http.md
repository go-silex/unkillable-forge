# Manage HTTP publication API

This JSON and streaming interface is implemented by the separate [manage Worker](../adapters/http/manageWorker.ts). It composes Catalogue authentication, Publication and Revision Store; it is not a second authorization or publication engine. The [core contract §9.3](forge-core-contract.md#93-publication-commit-composition) owns the publication and commit semantics.

**F04 is not yet delivered or accepted.** On 2026-11-14 the operator explicitly approved a real **32 MiB capacity witness** for F04 rather than waiting for the unknown largest historical file. That witness and real Cloudflare body, memory, CPU and cardinality capacity remain unproved. Every larger real file must be tested, with verified chunking if needed, before its migration; no file is excluded and no permanent 32 MiB product cap is established. Local tests, including a synthetic 7,997,944-byte file, do not prove that envelope. This amendment authorizes no Cloudflare resources, deployment, cleanup or migration.

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

The domain's10,000-file/1,000-page/20,000-edge ceilings are unchanged, but an actual serialized command must also fit the explicit transport profile. A32KiB test setting cannot admit a10k-file begin. Measure encoded request/JSON parameter sizes, native whole-batch duration and cardinality rather than treating individual validation maxima or one32MiB upload as proof of their joint capacity.


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


This interface adds no MCP business-client proof, F05 serving, GC scheduler or maintenance endpoint. It changes no legacy URLs or Shlink behavior. Real three-client business publication belongs to F08; further cloud operations require separate approval.

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
- Candidate `02ec355da6ab1b2c5549aa99406eb7e1bb670772` separately passed actual required CI353 Vitest/205 Python with a verified identical CI merge tree, but its independent reviews found the corrected defect and missing race evidence. That CI/review does not approve these later changes. New final-SHA reviews/CI, local joint-max admission and authorized real Cloudflare capacity/CPU/memory proof remain outstanding. F04 is not delivered and no F04 cloud operation is authorized.

