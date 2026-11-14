# Manage HTTP publication API

This JSON and streaming interface is implemented by the separate [manage Worker](../adapters/http/manageWorker.ts). It composes Catalogue authentication, Publication and Revision Store; it is not a second authorization or publication engine. The [core contract §9.3](forge-core-contract.md#93-publication-commit-composition) owns the publication and commit semantics.

**F04 is not yet delivered or accepted.** The approved largest-file scope and real Cloudflare body, memory and CPU capacity remain unproved; no capacity amendment has been approved. Local tests, including a synthetic 7,997,944-byte file, do not establish the largest approved file or a production support envelope. This document authorizes no Cloudflare resources, deployment or migration.

## Endpoints and commands

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/publication` | UTF-8 JSON command; no query parameters | Status, receipt or `null` |
| `PUT /api/publication/upload?sessionId=<encoded>&path=<encoded>` | Raw file bytes | Status |

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

The authoritative command and result fields are in [Publication types](../domains/publication/types.ts). Every DTO field is required, including explicit nulls; unknown fields are rejected. Integers must be finite safe integers. Metadata may be any finite JSON value within the body and depth bounds. Publication retains responsibility for semantic validation, ownership, current authorization, idempotency and promotion.

Typical flow: `begin` → upload client files and `materialize` each retained base file → `seal` → `commit`. `status` reports staging progress; `restore` promotes a retained revision and `unpublish` performs the guarded metadata transition. `abort` returns `null` after the domain operation, including its deliberately indistinguishable no-op cases; an authenticated owner can close their own session even after revocation. It is not an implicit disconnect action.

POST requires `Content-Type: application/json`, optionally `charset=utf-8`. PUT requires `application/octet-stream` without parameters; the resource's content type comes from its manifest, not this header. Content-Encoding must be absent or `identity`. A missing PUT body means zero bytes; a nonzero declared Content-Length with no body is invalid. JSON requires a body.

## Authentication and origin

Configuration, effective HTTPS URL origin and any literal Host header are checked against the configured management host before authentication. Forwarded host and Referer are not trusted. Host and Origin checks precede Catalogue's possible principal self-registration. Route, method, selector and framing checks also precede authentication; authentication precedes reading or parsing either body.

- If `Origin` is present, it must exactly equal `https://<manageHost>`, including for assertion-header requests. Empty, `null`, joined, read-origin and other values are refused.
- Without Origin, any Cookie header is refused. Native mode requires a nonempty `Cf-Access-Jwt-Assertion`; if `Sec-Fetch-Site` is present it must be `none`. Native clients must not send a cookie jar in this mode.
- With the exact Origin, Catalogue can authenticate the Access cookie or assertion. An assertion takes precedence and a bad or empty assertion does not fall back to a cookie. A share cookie is not a management credential. An `Authorization` bearer alone is not interpreted by this Worker; Access supplies the signed assertion after authenticating its client.

Catalogue verifies the Access JWT and obtains keys only from the configured Access team certificate endpoint. Its outbound JWKS request uses manual redirect handling and rejects non-success responses, including redirects; it never follows a redirected key source. See [identity.ts](../domains/catalogue/identity.ts).

## Bounds, streaming and recovery

Content-Length, when present, must be one nonnegative decimal safe integer and must not exceed the configured cap. Actual bytes are counted even when length is absent or misleading. JSON is read with a deadline, decoded as fatal UTF-8 and checked for finite values and configured nesting depth. A `begin` file larger than `maxUploadBytes` is rejected whether its source is client or base.

Uploads are pull-driven and forward byte chunks without buffering the entire file or rehashing it in JavaScript. Publication enforces its own upload deadline; Store verifies the expected size and native checksum. An interrupted open request body errors the stream and does not implicitly abort the session. Use `status` and retry missing files. A disconnect after EOF or a lost commit response is uncertain, not a rollback: reconcile using `status` and the same idempotency key. Native storage cancellation is not a guarantee that a provider operation physically rolled back; see [core contract §9.3](forge-core-contract.md#93-publication-commit-composition).

## Responses and errors

Success is HTTP 200 with `{"ok":true,"result":...}`. A status contains exactly `sessionId`, `artifactId`, `revisionId`, `baseRevisionId`, `expiresAt`, `state`, and `files` entries of `path`, `source`, `stored`. A receipt contains exactly `artifactId`, `revisionId`, `contentVersion`, and `pages` entries of `pageId`, `url`. Receipt URLs are the domain's relative paths. Abort returns `result: null`.

Errors have the fixed shape `{"ok":false,"error":{"code":"..."}}`; no exception detail or credentials are returned.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Invalid JSON, UTF-8, shape, depth, selector or framing |
| 401 | `unauthenticated` | Missing or invalid management identity |
| 403 | `forbidden` | Host, Origin or policy refusal |
| 404 | `not_found` | Unknown route or unavailable resource |
| 405 | `method_not_allowed` | Known route with another method; `Allow` names the supported method |
| 408 | `request_timeout` | Command read deadline or observed interrupted body |
| 409 | `conflict` | Idempotency, version or storage conflict |
| 409 | `upload_incomplete`, `not_sealed`, `session_closed` | Corresponding publication state |
| 410 | `session_expired` | Session expired |
| 413 | `payload_too_large` | Configured byte cap exceeded |
| 415 | `unsupported_media_type` | Unsupported media type or encoding |
| 422 | `invalid_state`, `integrity_error` | Invalid domain state/input or a typed Store integrity error |
| 500 | `internal_error` | Explicit invariant violation |
| 503 | `configuration_error`, `unavailable` | Invalid configuration/instance mismatch, or unavailable/unclassified operation |

An unclassified native R2 checksum or length failure may be `503 unavailable`; the adapter does not infer integrity errors from provider text. HEAD returns the same status and headers without a body. Every response has `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, JSON content type and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. There are no CORS allow headers, redirects or successful preflight.

## Trusted configuration and local profile

The server requires a D1 `DB`, private R2 `REVISION_BYTES`, and the whole validated `FORGE_INSTANCE` and `FORGE_SHARE_VERIFIER_KEYS` JSON configuration; `FORGE_SHARE_SEAL_KEY` is optional. See [instance configuration](forge-core-contract.md#4-instance-configuration-s1) and the [parser](../domains/catalogue/instance-config.ts). Management host is distinct from read hosts; `.workers.dev` and `.pages.dev` hosts are forbidden by the core contract.

Two additional required JSON **strings**, with exact keys and safe integer values, have no defaults:

| Variable | Required keys |
|---|---|
| `FORGE_PUBLICATION_OPTIONS` | `sessionTtlMs`, `maxUploadTimeoutMs`, `retainMs`, `marginMs`, `manageClockSkewMs`, `readClockSkewMs` |
| `FORGE_MANAGE_TRANSPORT` | `maxCommandBytes`, `commandReadTimeoutMs`, `maxUploadBytes`, `maxJsonDepth` |

Transport values must be positive; `maxJsonDepth` is at most 64, and command and upload timeouts must fit the timer range (at most 2,147,483,647 ms). The Publication constructor enforces positive session/upload durations, nonnegative skews, retention of at least 900,000 ms plus both skews, and margin of at least the upload timeout plus both skews. Safe arithmetic and a matching Store instance are required. Invalid configuration fails closed with `503 configuration_error`. Values must be selected from an independently measured deployment profile; test values are not production defaults.

Immutable runtime dependencies are cached in a WeakMap per actual environment object, including Catalogue's JWKS cache. Actors, roles, epochs, authorization decisions and receipts are not cached; each accepted request authenticates anew and domain operations consult current authority.

[`wrangler.manage.toml`](../wrangler.manage.toml) is **local development only: do not deploy it**. Missing remote identifiers can cause Wrangler to auto-provision real D1/R2 resources on deploy; `workers_dev = false` and `preview_urls = false` do not prevent that. Do not add fake IDs to imply safety. Its compatibility date is `2025-02-14` with `enable_request_signal` and `unhandled_rejection_after_microtask_checkpoint`; the latter applies standard checkpoint timing, not suppression of genuine unhandled rejections. It has no deployment approval or production values.

## Local evidence and boundaries

The following commands target the current engine typecheck and the isolated HTTP and native-JWKS projects:

```sh
./node_modules/.bin/tsc -p tsconfig.engine.json --noEmit
./node_modules/.bin/vitest run --project manage-http tests/engine/manage-http.security.test.ts tests/engine/manage-http.publication.test.ts tests/engine/manage-http.config.test.ts
./node_modules/.bin/vitest run --project native-jwks tests/engine/native-jwks.test.ts
```

The local targeted checks passed (32 tests across four files). A separate local socket exercise used the actual default Worker, native JWKS, D1 and R2: after a disconnected upload the old snapshot remained selected, and retry produced the expected new content version, exact bytes and native SHA. These are local observations, not Cloudflare capacity or deployment proof. Native EOF and internal asynchronous diagnostics were observed in some HTTP failure tests; their existence is not a claim that every runtime diagnostic is harmless or resolved.

This interface adds no MCP business-client proof, F05 serving, GC scheduler or maintenance endpoint. It changes no legacy URLs or Shlink behavior. Real three-client business publication belongs to F08; further cloud operations require separate approval.
