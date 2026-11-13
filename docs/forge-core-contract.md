# Forge core contract (F03)

Decision: [ADR 0002](architecture/adr/0002-axis-of-decomposition-business-authority.md) · Vocabulary: [GLOSSARY](../GLOSSARY.md) · Plan: [forge-convergence-plan.md](forge-convergence-plan.md) (F03 row, §2.1–§2.5, §7, §9) · Live state: [forge-convergence-status.md](forge-convergence-status.md)

## 1. Status and authority

- This document is the implementable contract for lot F03: artefact/page/revision model, D1 schema, instance configuration, identity, roles, ACL, route resolution and the first executable read decisions. The F03 PR implements it.
- **Owner-approved** items come from the accepted plan and the owner's instruction to build the new engine as designed. **Contract decisions** are technical choices made here to make the plan implementable; they are marked *(contract decision)* and can be changed by a later contract revision without owner arbitration. **Owner decisions** still open are listed in §17 and none blocks F03 code.
- The legacy runtime (`functions/`, `plugins/silex-forge/`, `site/`) is the parity oracle and stays untouched by F03.
- **Normative SQL lives in code.** The schema is [`migrations/0001_catalogue.sql`](../migrations/0001_catalogue.sql). The guard, ownership admission, read, registration and builder statements are in [`domains/catalogue/`](../domains/catalogue/) (`guard.ts`, `read.ts`, `principals.ts`, `commands.ts`, `revision-paths.ts`, `catalogue-list.ts`). This contract states the rules that SQL must satisfy, the interfaces and the tests, and keeps no copy of the SQL. Code that breaks a rule here is a defect; changing a rule is a contract revision.

Oracles:

| Instance | Source | Revision |
|---|---|---|
| Unkillable (Silex) | this repository, `functions/` | `9722984354d4597d765b2d645240e6b2f98f3068` |
| Roxabi (R) | `Roxabi/roxabi-forge`, `functions/` | `9c7dda4fd6427dde7da5f474a4519fffefe3ba6a` |

Parity target is the observed HTTP behaviour of the deployed instance, not the internals of Pages or `ASSETS.fetch`. Observations are recorded in §13. Where no eligible deployed content exists to observe (OR-1), F03 encodes source-derived expectations instead: the pinned oracle source, the official Pages route-matching rule, and real-D1 tests through real `Request`/`URL` objects. Each expectation names its evidence level (production observation, source, documentation, local Pages run) and none is presented as deployed-instance parity. Historical HTTP parity stays a F10/F13 gate.

## 2. F03 scope

F03 delivers, executable and tested on real D1 bindings in workerd:

1. Instance configuration parsing for the read and manage surfaces, failing closed (§4).
2. Access identity verification with explicit assurance per surface (§5).
3. D1 migration `0001_catalogue.sql`: catalogue, policy, routes, revisions, mounts, ownership, grants and guard tables (§7).
4. The mutation guard: one SQL statement, named CHECK verdicts, error mapping and `executeGuarded` (§8).
5. Policy commands and the statement builders later lots compose (§9).
6. Share-key verification, sealing and exact legacy import (§10).
7. URL grammar parsing, normalisation and outcome mapping for both instances (§11).
8. Read decisions for every grammar plus catalogue listing (§12).
9. The test harness and the behavioural test matrix (§14).

F03 does **not** deliver: serving bytes or headers (F05), publication sessions, R2 and commit (F04), MCP (F07), stdio (F08), OG and cards rendering (F09), import (F10), deployment and bootstrap (F11). §15 maps each duty.

## 3. Domain model

```
Instance 1 ── * Artefact 1 ── * Revision (immutable, sealed)
                    │  └── active revision (0..1, Publication's CAS)
                    └── 1..* Page ── 1 primary Route (subtree slug | tree path)
                                 ├── * Alias (redirect routes)
                                 ├── Visibility (private | shared | public)
                                 └── 0..1 active Share grant
Revision ── * Resource (document | subdocument | fragment | asset)
Revision ── * RevisionPage (page, document path, catalogue metadata)
RevisionPage ── * Ownership edge → (resource path, provider artefact)
Mount: path → (artefact, active revision, kind)   (one artefact per path)
```

Rules:

- **Identity is opaque.** Pages, artefacts, revisions, grants, principals, role grants and events have random IDs: prefix `pg_`, `ar_`, `rv_`, `gr_`, `pr_`, `rg_`, `ev_` followed by 26 characters of lowercase RFC 4648 base32 (`a-z2-7`) encoding 16 random bytes *(contract decision)*. Slugs and tree paths are route keys.
- **Page ≠ file.** A page is the ACL unit; its document is one resource. Subtree pages (Silex `/a/<slug>/`) govern every resource under their prefix. Tree pages (R) govern their document; fragments and assets are reached only through ownership.
- **Ownership is declared, not guessed.** A revision's pages declare the paths they use. Access to a fragment or asset outside a subtree requires an owner page whose *active* revision (for a pinned read, whose authorized revision) declares that path together with the artefact that provides it. Ownership may cross artefacts (a shared asset mounted by artefact Y and used by pages of artefact X). The edge then names Y, and only Y's current mount satisfies it: the resource follows Y's active revision, not X's revision. A later mount of the same path by another artefact Z never satisfies the edge. Adding or retargeting a cross-artefact edge needs administrator or installation-publisher authority (§9, ownership admission).
- **No laundering.** A path is mounted by exactly one artefact with exactly one kind. A path that is a page document can never be mounted or read as a fragment or asset (§7 foreign keys). Inside the pinned namespace, a page reads only its own document, its subtree, or fragments and assets its revision owns. A resource held by the pinned revision itself always takes precedence over any mount.
- **Revision ≠ authorization.** Knowing a revision ID grants nothing. A public page does not open its older revisions.
- **Visibility unknown means private**; the schema only admits the three values.

## 4. Instance configuration (S1)

One non-secret JSON variable `FORGE_INSTANCE` per instance, the same in both Workers, plus secrets *(contract decision)*. Values that identify Access applications are deploy-time values and never enter git (AGENTS rule on infrastructure IDs).

```ts
// domains/catalogue/instance-config.ts (S1)
export type RouteGrammar = "subtree" | "tree"
export type ShareGrammar = "slug" | "page" | "card"
export type LoginMode = "serve-shell" | "redirect-access-login"

export interface ShareVerifierKey { readonly kid: string; readonly key: CryptoKey } // HMAC-SHA-256
export interface ShareSealKey { readonly kid: string; readonly key: CryptoKey }     // AES-256-GCM

export interface InstanceBase {
  readonly instanceId: string
  readonly canonicalHost: string
  readonly aliasHosts: readonly string[]
  readonly accessTeamDomain: string
  readonly routeGrammars: readonly RouteGrammar[]
  readonly shareGrammars: readonly ShareGrammar[]
  readonly shareVerifierKeys: readonly ShareVerifierKey[] // [current, previous?]
}
export interface ReadInstanceConfig extends InstanceBase {
  readonly surface: "read"
  readonly readAudiences: readonly string[]
  readonly login: LoginMode
  readonly shareCookie: boolean
  readonly shellPaths: readonly string[]
}
export interface ManageInstanceConfig extends InstanceBase {
  readonly surface: "manage"
  readonly manageHost: string
  readonly manageAudiences: readonly string[]
  readonly shellPaths: readonly string[]          // manifest validation (§9, validateRevisionPaths)
  readonly shareSealKey: ShareSealKey | null
}
export type ConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly errors: readonly string[] }

export function parseReadConfig(env: Readonly<Record<string, unknown>>): Promise<ConfigResult<ReadInstanceConfig>>
export function parseManageConfig(env: Readonly<Record<string, unknown>>): Promise<ConfigResult<ManageInstanceConfig>>
```

Bindings and variables:

| Name | Kind | Read Worker | Manage Worker |
|---|---|---|---|
| `DB` | D1 binding | required | required |
| `FORGE_INSTANCE` | JSON var | required | required |
| `FORGE_SHARE_VERIFIER_KEYS` | secret, JSON `[{"kid","key"}]`, base64url key ≥ 32 bytes, 1–2 entries, first mints | required | required |
| `FORGE_SHARE_SEAL_KEY` | secret, JSON `{"kid","key"}`, base64url 32 bytes | **must be absent** (error if bound) | optional; absent → reveal unavailable |

`FORGE_INSTANCE` is one document per instance, identical in both Workers:

| Fields | Group | Read parser | Manage parser |
|---|---|---|---|
| `instanceId`, `canonicalHost`, `aliasHosts`, `accessTeamDomain`, `routeGrammars`, `shareGrammars` | common | required | required |
| `shellPaths` | common | required, exposed | required, exposed |
| `readAudiences`, `login`, `shareCookie` | read | required, exposed | required, validated, not exposed |
| `manageHost`, `manageAudiences` | manage | required, validated, not exposed | required, exposed |

Both parsers require and validate the **whole document** (every group, every field and every cross constraint) before building their typed result. Each then exposes only its own surface's fields. A parser never skips the other group's fields or cross constraints because its typed result does not carry them. An unknown field is an error.

Validation (all errors collected; any error → the Worker answers every request `503`, `cache-control: no-store`, no partial defaults):

- `instanceId` matches `^[a-z][a-z0-9-]{1,39}$` and equals `instance_meta.instance_id` (checked inside every decision and guard, §8, §9, §12).
- Hosts are lowercase ASCII hostnames without scheme, port, path or wildcard; none ends in `.pages.dev` or `.workers.dev`; `aliasHosts` unique and `canonicalHost ∉ aliasHosts`. Cross constraint: `manageHost ∉ {canonicalHost} ∪ aliasHosts`. There is no request-host fallback.
- `accessTeamDomain` matches `^[a-z0-9-]+\.cloudflareaccess\.com$`.
- Audience lists are non-empty and unique when present. Cross constraint: `readAudiences ∩ manageAudiences = ∅`.
- `routeGrammars` and `shareGrammars` non-empty, known values, no duplicates. `shareCookie: true` requires `"page"` in `shareGrammars` and `"tree"` in `routeGrammars`. `"page"` requires `"tree"`; `"card"` requires `"tree"` or `"subtree"`; `"slug"` requires `"subtree"`.
- `shellPaths` are absolute, unique, include `/login`, and none satisfies the shared `isReservedShellPath(path)` predicate (§11.2). This predicate depends only on fixed namespaces, never on `shellPaths` itself: using the content predicate `isReservedPath` here would reject every configured shell path against its own list.
- Secrets: key material decodes and imports with WebCrypto; `kid` matches `^[a-z0-9]{1,16}$`; verifier `kid`s are unique. The read parser fails when `FORGE_SHARE_SEAL_KEY` is bound.

Instance values (non-secret parts):

| Field | Unkillable | Roxabi |
|---|---|---|
| `canonicalHost` | `forge.unkillablecompanies.com` | `forge.roxabi.dev` |
| `aliasHosts` | `forge.gosilex.com` (an edge rule also redirects its GET/HEAD; that rule stays infrastructure, F11/F14) | none |
| `readAudiences` | the existing login application audience (unchanged) | the existing login application audience (unchanged) |
| `login` | `serve-shell` | `redirect-access-login` |
| `routeGrammars` | `["subtree"]` | `["tree", "subtree"]` |
| `shareGrammars` | `["slug"]` | `["page", "card", "slug"]` |
| `shareCookie` | `false` | `true` |
| `shellPaths` | `/`, `/index.html`, `/login`, `/login.html`, `/robots.txt`, `/favicon.ico`, `/apple-touch-icon.png`, `/images/favicon.png` | `/`, `/index.html`, `/login`, `/login.html`, `/robots.txt`, `/favicon.ico`, `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`, `/_shared/hero-base.css`, `/_shared/hero-base.js`, `/_shared/gallery-base.css`, `/_shared/gallery-base.js`, `/_shared/fgraph-base.css`, `/_shared/explainer-base.css` |

Two Workers per instance *(contract decision)*: a **read Worker** on the read origin and a **manage Worker** on the management origin, built from the same code, sharing the instance's D1 (and R2 from F04). Wrangler configurations for them are created by F04/F05 with real entry points; F03 adds none.

What the split buys, and what it does not:

- The read Worker exposes no management endpoint and never holds the seal key, so it cannot reveal a share key.
- Artefact HTML, served on the read origin, cannot reach management credentials or endpoints.
- The read Worker does hold the share verifier keys, which it needs to verify keys and to sign pinned-read tokens (§12.6), plus a read-write D1 binding. A compromised read Worker could therefore compute verifiers for keys of its choice, or write the catalogue.
- No third Worker and no read-only D1 binding is assumed. This is recorded as expected debt in ADR 0002 and §17.

## 5. Identity and assurance (S4)

```ts
// domains/catalogue/identity.ts (S4)
export interface VerifiedIdentity {
  readonly issuer: string            // "https://<accessTeamDomain>"
  readonly subject: string | null    // null only on surface "read" (service tokens carry an empty sub)
  readonly email: string | null      // display only, never an authority key
  readonly audience: string          // the configured audience that matched
  readonly surface: "read" | "manage"
  readonly expiresAt: number         // epoch seconds
}
export interface AccessVerifier {
  readonly teamDomain: string
  readonly audiences: readonly string[]
  readonly surface: "read" | "manage"
}
export type JwksSource = (teamDomain: string) => Promise<readonly JsonWebKey[]>
export function accessJwksSource(fetcher?: typeof fetch): JwksSource
export function authenticate(request: Request, verifier: AccessVerifier, jwks: JwksSource, nowSeconds: number): Promise<VerifiedIdentity | null>
export function isVerifiedIdentity(value: unknown): value is VerifiedIdentity // true only for an object returned by authenticate
```

Rules (parity with Silex `functions/_lib/access.ts` JWT verification, plus surfaces):

- Token from header `Cf-Access-Jwt-Assertion`, else cookie `CF_Authorization`.
- `alg` must be `RS256`; signature verified with WebCrypto against the JWKS of `https://<teamDomain>/cdn-cgi/access/certs`. A `kid` selects the key; without `kid`, every key is tried.
- `exp` required; `exp` and `nbf` checked with ±30 s skew; `iss` must equal `https://<teamDomain>` (a trailing slash is accepted); `aud` (string or array) must intersect `verifier.audiences`.
- Manage surface: `sub` must be a non-empty string, else `null`. Read surface: `sub` may be empty.
- `accessJwksSource` caches key material per isolate for one hour. A fetch or parse failure returns no keys, so verification fails closed. The cache holds keys only, never decisions.
- Verifiers are built only inside Catalogue: `resolveRead` uses `readAudiences`, and `authenticateManage` (§9.1) uses `manageAudiences`. No adapter builds an `AccessVerifier` or chooses a surface.
- `authenticate` returns a frozen identity registered in a module-private `WeakSet`, and `isVerifiedIdentity` is true only for such an object. `decideRead` grants the team basis only to an identity that is registered, read-surface, unexpired, and whose audience is a configured read audience (§12.1). A structurally identical object grants nothing. This is an API boundary against adapter forgery, not a defence against hostile code running in the same isolate.
- A management identity is not proof of the read audience and never makes someone a team reader. A read identity never authorizes a mutation: it yields no `ManageActor` (§9.1), and the guard's surface rule (§8.1) stays as defence in depth.
- Principals are keyed by `(issuer, subject)`. Whether Access issues the same `sub` across browser sessions and Managed OAuth is measured by F06; roles attach only to manage-surface principals, so a read/manage `sub` difference does not affect reads.

## 6. Roles, scopes and actions

Owner-approved (plan §2.5): team readers read and never mutate; publishing and policy changes need a role; authority is revalidated inside the transaction.

| Action | Who may | Target must | Versions asserted |
|---|---|---|---|
| `create_page` | admin · publisher@installation | page ID unused; revision belongs to artefact; new revision's paths unclaimed by other artefacts | actor authority |
| `stage` (F04: begin/upload/seal) | admin · publisher@installation · publisher@page (page given) | page live if given; none → installation scope only | actor authority |
| `publish` | admin · publisher@installation · publisher@page | page live in artefact; revision belongs to artefact; paths unclaimed by other artefacts | actor authority · page policy epoch · artefact content version |
| `unpublish` | same as `publish` | page live | actor authority · policy epoch · content version |
| `restore_page` (F04 restore, §9.4) | admin · publisher@installation | page tombstoned in artefact; revision belongs to artefact and contains the page; paths unclaimed by other artefacts; former route free | actor authority · artefact content version (the tombstone is the page precondition; the effect increments the policy epoch) |
| `set_visibility` (private, public) | same as `publish` | page live | actor authority · policy epoch |
| `share` | same as `publish` | page live | actor authority · policy epoch |
| `rotate_share` · `revoke_share` | same as `publish` | page live, grant active on page | actor authority · policy epoch |
| `reveal_share` | same as `publish` | grant active with a sealed copy | actor authority · policy epoch |
| `import_share` | admin | page live | actor authority · policy epoch |
| `set_alias` | admin | target page live if given | actor authority |
| `assign_role` · `revoke_role` · `disable_principal` | admin | target principal exists; revoked role grant active | actor authority · target authority; last active admin protected |

- `publisher@page` = role `publisher`, scope `page`, on that page. A multi-page artefact needs one guard row per page, so a page-scoped publisher cannot publish an artefact containing pages outside its scope.
- `restore_page` uses `create_page` authority: the page's route was released at unpublish, and reclaiming an address is an installation-level act *(contract decision)*.
- Every action requires an active principal on the manage surface, presented as a `ManageActor` minted by `authenticateManage` (§9.1). No API accepts a principal ID, surface or epoch for the acting principal.
- The action list is closed: the guard refuses any other action as `forbidden` (deny by default). Adding an action requires three changes together: a Catalogue-owned migration of the `mutation_events.action` CHECK, the guard's action list, and the new action's authority rule.
- Ownership edges (§3) are written in a guarded batch of their revision (§8.3, §9). An edge whose provider is another artefact is admitted only in two cases: the actor is an administrator or installation publisher, or an identical edge (owner page, path, provider) is already in the owner page's current active revision.
- First administrator per instance: inserted by the F11 bootstrap runbook (`origin = 'bootstrap'`), after that person has signed in once on the management origin. Who it is belongs to G4 (§17).

## 7. D1 schema (S2)

File `migrations/0001_catalogue.sql`, wrangler D1 migration format, raw SQL, no ORM *(contract decision: the guard must be literal, reviewable SQL)*. D1 enforces foreign keys. F04 adds `0002_*` for publication sessions, uploads and idempotency; it may add columns to `revisions`, never redefine the tables below.

Required content, table by table (the migration is the normative SQL):

| Table | Rules |
|---|---|
| `instance_meta` | one row (`singleton = 1`); `instance_id` follows the §4 grammar; `contract_version = 1` |
| `principals` | `pr_` ID; `(issuer, subject)` unique; `issuer` an `https://` URL of at most 255 characters; `subject` 1–255 characters; `status` `active` or `disabled`, with `disabled_at` set exactly when disabled; `authority_epoch ≥ 0` |
| `artifacts` | `ar_` ID; `origin` `published` or `imported`; `active_revision_id` nullable, and when set a revision of the same artefact (composite foreign key); `content_version ≥ 0` |
| `pages` | `pg_` ID; one artefact; `visibility` `private`, `shared` or `public`, default `private`; `policy_epoch ≥ 0`; tombstone time and author; `(page_id, artifact_id)` unique |
| `role_grants` | `rg_` ID; `role` `publisher` or `admin`; scope `installation` or `page`, with `scope_page_id` set exactly for `page`; `admin` only at installation scope; `origin = 'bootstrap'` exactly when `granted_by` is null; revocation time and author set together; at most one active grant per (principal, role, scope) |
| `revisions` | `rv_` ID; one artefact, `(artifact_id, revision_id)` unique; manifest SHA-256 (64 lowercase hex) and object key |
| `revision_resources` | primary key (revision, path); `(revision, path, kind)` unique. Path: absolute, 2–1024 characters, without a `//`, a `.` or `..` segment, a trailing `/` or a backslash, and outside `/s`, `/_revisions`, `/api`, `/registry/*`, `/manifest.json` and `/asset-owners.json`. Kind: `document`, `subdocument`, `fragment` or `asset`; an `.html` path is never an `asset`. Also SHA-256, size ≥ 0 and content type |
| `revision_pages` | primary key (revision, page); one page per document path in a revision; `(revision, document_path, 'document')` references `revision_resources`; `metadata_json` valid JSON of at most 8192 characters. That page and revision share an artefact is a Publication invariant, not a schema rule. An inconsistent row stays inert, because every read joins revision and page through the page's artefact (§12) and every guard and ownership admission asserts it (§8.1, §9) |
| `mounts` | primary key `path` (one artefact per path); `(artifact, revision)` references `revisions`; `(revision, path, kind)` references `revision_resources`; `(path, artifact, kind)` unique |
| `routes` | Primary key (kind, key). Kinds `subtree`, `tree_page`, `redirect_exact`, `redirect_prefix`; page kinds carry page, artefact and document and no redirect field, redirect kinds the reverse.<br>`subtree`: key in the slug grammar (§11.3), document `/a/<key>/index.html`.<br>`tree_page`: key `?*.html`, relative, characters `[A-Za-z0-9._/-]`, no `//`, no `..`, never under `a/`, document `/<key>`.<br>Redirect kinds: key and target are same-origin paths of visible ASCII (`!`–`~`). They start with `/` but not `//`, and contain no backslash, `?`, `#` or control character, and no percent-encoded `/`, `.`, `\`, `%`, control or DEL. The key has no `..`; a prefix key ends with `/`. Status 301, 302, 307 or 308.<br>At most one primary route per page; `(page, artifact)` references `pages`; `(document_path, artifact, 'document')` references `mounts` (laundering refused) |
| `resource_owners` | primary key (owner revision, owner page, path); `(owner revision, owner page)` references `revision_pages`; path absolute, at most 1024 characters; `provider_artifact_id` (not null) references `artifacts`; `admission` is `local`, `global` or `preserved`, and the value `forbidden` violates the named CHECK `guard_forbidden` (§9, ownership admission) |
| `share_grants` | `gr_` ID; key verifier `(key_kid, key_hmac)` (§10); `mode` `follow_active` or `pinned`, with `pinned_revision_id` set exactly when pinned; `origin` `minted` or `imported`; sealed copy and seal `kid` set together and erased on revocation; revocation time and reason (`revoked`, `rotated`, `visibility`, `unpublished`) set together; at most one active grant per page |
| `mutation_events` | `ev_` ID; `action` among the 15 guard actions (§8.2); request digest of 64 lowercase hex; no foreign key; `verdict` in the guard domain, with one named CHECK per refusal: `guard_instance_mismatch`, `guard_unauthenticated`, `guard_forbidden`, `guard_not_found`, `guard_conflict`, `guard_invalid_state`, `guard_last_admin` |

Indexes: pages by artefact, mounts by artefact, ownership edges by path, active grants by `(page, key_kid, key_hmac)`, events by page and time.

Notes:

- `instance_meta` is empty after migration; the F11 bootstrap inserts the single row. Until then every decision answers `instance_mismatch` (fail closed).
- `mounts` mirrors the active revision of each artefact: `mounts.revision_id = artifacts.active_revision_id` for every row. Publication maintains it in its commit; read joins require the equality, so a stale row is never served.
- Laundering is refused by the schema: a page route references `mounts(path, artifact_id, 'document')`; changing that mount's kind or deleting it while the route exists violates the foreign key.
- A tree-page route key never starts with `a/` (§11.3: `/a/` paths are never tree-page-shaped). A page document path therefore determines its primary route: `/a/<slug>/index.html` ↔ `subtree <slug>`, any other path ↔ `tree_page` without the leading slash. `restorePageStatements` derives the route from it (§9.4).
- `mutation_events` has no foreign keys: it is the guard's verdict carrier and the audit log, and must never fail for a reason other than its named constraints.
- Every primary-key column is declared `NOT NULL`. SQLite does not imply it for a primary key that is not `INTEGER PRIMARY KEY`, and a `CHECK` that evaluates to `NULL` passes, so the format checks alone would admit a `NULL` key.

Write authority (statement builders are the only writers):

| Table | Builder owner | Composed by |
|---|---|---|
| `instance_meta` | F11 bootstrap runbook | — |
| `principals`, `role_grants` | Catalogue & Policy | guarded role and principal commands; principal self-registration (§9.1, unguarded exception, new `principals` rows only); F11 bootstrap for the first admin (unguarded operator exception) |
| `pages` (insert, policy fields, tombstone), `routes`, `share_grants` | Catalogue & Policy | Catalogue commands; Publication's seal, commit and restore batches (F04); import (F10) |
| `resource_owners` | Catalogue & Policy (`executeGuarded` ownership admission) | Publication's seal or commit batch that first writes the revision's edges (F04); import (F10) |
| `artifacts`, `revisions`, `revision_resources`, `revision_pages`, `mounts` | Publication (F04) | Publication; import (F10) through Publication |
| `mutation_events` | Catalogue & Policy (guard) | every guarded batch |

Epochs: `pages.policy_epoch` increments on every change of visibility or grants, on unpublish and on restore; `principals.authority_epoch` on every role grant, role revocation or disable; `artifacts.content_version` on every commit (a restore included) or unpublish of the artefact (F04).

## 8. Mutation guard (S2)

Contract decision: a guard is an `INSERT … SELECT` into `mutation_events` whose `verdict` is computed in SQL. Any verdict other than `ok` violates exactly one named CHECK constraint, so D1 aborts the whole batch (a batch is one SQL transaction that rolls back on any failing statement). The `ok` row stays as the audit record. Rejected alternatives: triggers (extra moving part, `RAISE` messages not yet pinned on D1), zero-row compare-and-set (a refusal must never look like success).

### 8.1 Statement

Normative SQL: `GUARD_SQL` in [`domains/catalogue/guard.ts`](../domains/catalogue/guard.ts), bound only by `executeGuarded`. The verdict is the first rule that matches, in this order:

1. **Instance.** No `instance_meta` row carries `?2` → `instance_mismatch`.
2. **Surface.** `?5` is not `manage` → `forbidden`.
3. **Actor.** `?4` is not an active principal → `unauthenticated`; its `authority_epoch` differs from `?11` → `conflict`.
4. **Authority** (`forbidden` when it fails):
   - `?3` is not one of the 15 actions → refused (deny by default, §6);
   - `import_share`, `set_alias`, `assign_role`, `revoke_role`, `disable_principal`: an active `admin` grant;
   - `create_page`, `restore_page`: an active `admin` or installation `publisher` grant;
   - `stage`, `publish`, `unpublish`, `set_visibility`, `share`, `rotate_share`, `revoke_share`, `reveal_share`: an active `admin` grant, installation `publisher` grant, or `publisher` grant scoped to page `?6`.
5. **Target** (`not_found` unless stated):
   - `create_page`: page `?6` already exists → `conflict`;
   - `publish`, `unpublish`, `set_visibility`, `share`, `rotate_share`, `revoke_share`, `reveal_share`, `import_share`, and `stage` with a page: page `?6` is live in artefact `?7`;
   - `create_page`, `publish`, `restore_page`: revision `?17` is given and belongs to artefact `?7`;
   - `restore_page`: page `?6` belongs to `?7`, and `revision_pages(?17, ?6)` exists;
   - `set_alias` with a target page: that page is live;
   - `rotate_share`, `revoke_share`, `reveal_share`: grant `?8` is active on page `?6`;
   - `assign_role`, `revoke_role`, `disable_principal`: principal `?9` exists. Also, `assign_role` with a page scope needs page `?6` to exist, and `revoke_role` needs role grant `?10` active for `?9`.
6. **Concurrency** (`conflict` unless stated):
   - `restore_page`: page `?6` is live;
   - the page policy actions of rule 5 (`stage` excluded): `policy_epoch` differs from `?12`;
   - `publish`, `unpublish`, `restore_page`: `content_version` differs from `?13`;
   - `assign_role`, `revoke_role`, `disable_principal`: the target's `authority_epoch` differs from `?14`. Disabling an already disabled principal → `invalid_state`;
   - path claims, for `create_page`, `publish` and `restore_page` with `?17`: a resource path of `?17` is mounted by another artefact, or lies under `/a/<key>/` for a subtree route `<key>` of another artefact.
7. **State:**
   - `share`, `rotate_share` with `?17`: the revision does not belong to `?7` → `invalid_state`;
   - `reveal_share`: the grant has no sealed copy → `invalid_state`;
   - `revoke_role` of an `admin` grant, or `disable_principal` of a principal holding one, would leave no other active administrator held by an active principal → `last_admin`.
8. Otherwise `ok`.

Parameters: `?1` event ID · `?2` configured instance ID · `?3` action · `?4` actor principal · `?5` actor surface (always `manage`; `?4` and `?11` come from the `ManageActor`, never from a caller field) · `?6` page · `?7` artefact · `?8` share grant · `?9` target principal · `?10` role grant · `?11` expected actor authority epoch · `?12` expected policy epoch · `?13` expected content version · `?14` expected target authority epoch · `?15` request digest (SHA-256 hex of the canonical command without secrets) · `?16` time (epoch ms) · `?17` revision being committed (required for `create_page`, `publish` and `restore_page`), or the pinned revision requested by `share` / `rotate_share` (NULL for `follow_active`). For `rotate_share` without a new mode, bind the existing pinned revision when the existing grant is pinned. A pinned revision missing from this artefact is therefore refused atomically as `invalid_state`. Unused parameters are bound to `NULL`; every comparison is null-safe (`IS NOT`), so a missing expected value is a `conflict`, never a pass.

`restore_page` neither binds nor asserts `?12`: the tombstone is its page precondition, no other action can change a tombstoned page, and every unpublish or restore also moves the artefact `content_version` asserted through `?13`.

Verdict priority is the `CASE` order: instance → surface → actor → actor epoch → authority → target → concurrency → state.

### 8.2 Interface

```ts
// domains/catalogue/guard.ts (S2)
export type GuardAction =
  | "create_page" | "stage" | "publish" | "restore_page" | "unpublish" | "set_visibility" | "share"
  | "rotate_share" | "revoke_share" | "reveal_share" | "import_share" | "set_alias"
  | "assign_role" | "revoke_role" | "disable_principal"
export interface GuardRequest { // what a command asserts; the acting principal comes only from the ManageActor
  readonly action: GuardAction
  readonly pageId?: string
  readonly artifactId?: string
  readonly grantId?: string
  readonly targetPrincipalId?: string
  readonly roleGrantId?: string
  readonly expectedPolicyEpoch?: number
  readonly expectedContentVersion?: number
  readonly expectedTargetAuthorityEpoch?: number
  readonly revisionId?: string
  readonly requestDigest: string
  readonly occurredAt: number
}
export interface OwnershipEdge { readonly ownerPageId: string; readonly path: string; readonly providerArtifactId: string }
export type PolicyErrorCode =
  | "instance_mismatch" | "unauthenticated" | "forbidden" | "not_found" | "conflict"
  | "invalid_state" | "last_admin" | "invariant_violation" | "unavailable"
export class PolicyError extends Error {
  readonly code: PolicyErrorCode
  readonly detail: string | null // e.g. "routes.route_key" for a unique conflict
}
export function mapPolicyError(error: unknown): PolicyError
export function executeGuarded(
  deps: ManageDeps, actor: ManageActor,
  guards: readonly GuardRequest[], effects: readonly D1PreparedStatement[],
  ownership?: { readonly revisionId: string; readonly edges: readonly OwnershipEdge[] },
  finalEffects?: readonly D1PreparedStatement[],
): Promise<readonly D1Result[]> // throws PolicyError
```

The guard statement builder and the ownership admission builder are module-internal. `executeGuarded` proceeds in this order:

1. It validates the handle (`requireManageActor`, §9.1) and the batch shape (§8.3 rule 2) before any D1 call.
2. It binds `?2` from `deps.config.instanceId`, `?4` and `?11` from the handle, and `?5 = 'manage'`.
3. It runs one batch: `[...guards, ...effects, ...ownership admissions, ...finalEffects]`.

### 8.3 Composition rules (normative for every lot)

1. Every D1 write to a table in §7's write-authority list goes through `executeGuarded`, with at least one guard. The batch is `[...guards, ...effects, ...ownership admissions, ...finalEffects]`. When ownership edges are present, every statement that changes an artefact's `active_revision_id` belongs in `finalEffects`, so admissions compare against the previous active revision. There are exactly two unguarded writes, and no policy effect may use either:
   - **Principal self-registration** (§9.1): inserts a new `principals` row for a verified manage-surface identity, keyed by `(issuer, subject)`, conditioned on `instance_meta`. It never writes a role and never changes an existing principal (no reactivation, no field update).
   - **Operator bootstrap** (F11 runbook): the `instance_meta` row and the first administrator's `role_grants` row (`origin = 'bootstrap'`), run once per instance by the operator with deploy credentials.
2. One guard row per targeted page (multi-page publish: one per page) or per targeted principal. `executeGuarded` first refuses an invalid handle (`unauthenticated`, §9.1). It then refuses structurally, with `PolicyError("invalid_state")` and no D1 call, when:
   - the guard list is empty;
   - an ownership edge has no guard that names the edge's owner page, uses an action among `stage`, `create_page` and `publish`, and has a `revisionId` strictly equal to the ownership revision;
   - it contains `assign_role`, `revoke_role` or `disable_principal` together with any other guard. Role and principal changes are one guard per batch: every guard runs before any effect, so two administrator removals in one batch would each still see the other administrator and remove both. Separate batches are separate transactions on the primary, so the second removal sees the first and gets `last_admin`;
   - two guards target the same page, or the same target principal (`targetPrincipalId`, not the common actor).

   Publication's multi-page batches (one guard per distinct page) stay allowed.
3. **Prepare, then guard.** A command may read current state to build its effects. Its effects must be correct for exactly the state whose versions the guard asserts: if the guard passes, nothing changed since the read. Immutable facts may be inspected during prepare, but the pinned-revision ownership check for `share` and `rotate_share` is also asserted in the shared guard via `?17`; it is never left solely to prepare or an adapter.
4. Never derive a refusal from `meta.changes`, zero affected rows, `INSERT OR IGNORE`, or `ON CONFLICT … DO UPDATE … WHERE` skipping a row. Path claims use plain `INSERT` (a primary-key violation is a conflict) or are asserted by the guard (`?17` path-claim check) before an unconditional upsert.
5. Publication's own session state (open, expired, digest match) is asserted by Publication in its own tables (F04) with the same named-CHECK technique; authority and catalogue versions stay in this guard. There is no second authority guard.

### 8.4 Error mapping

| D1 error message contains | `PolicyError.code` | HTTP status used by adapters |
|---|---|---|
| `CHECK constraint failed: guard_instance_mismatch` | `instance_mismatch` | 503 |
| `CHECK constraint failed: guard_unauthenticated` | `unauthenticated` | 401 |
| `CHECK constraint failed: guard_forbidden` (guard row or ownership admission) | `forbidden` | 403 |
| `CHECK constraint failed: guard_not_found` | `not_found` | 404 |
| `CHECK constraint failed: guard_conflict` | `conflict` | 409 |
| `CHECK constraint failed: guard_invalid_state` | `invalid_state` | 409 |
| `CHECK constraint failed: guard_last_admin` | `last_admin` | 409 |
| `UNIQUE constraint failed` | `conflict`, `detail` = `table.column` | 409 |
| `FOREIGN KEY constraint failed`, any other constraint | `invariant_violation` (logged) | 500 |
| anything else (network, timeout, overload) | `unavailable` | 503 |

The exact D1 message text is pinned by tests on the local workerd D1 (§14) and confirmed on the staging D1 by F11.

## 9. Policy commands and statement builders (S2)

```ts
// domains/catalogue/principals.ts (S2)
export interface ActorView {
  readonly principalId: string
  readonly status: "active" | "disabled"
  readonly authorityEpoch: number
  readonly roles: readonly { readonly roleGrantId: string; readonly role: "publisher" | "admin"; readonly scope: { readonly kind: "installation" } | { readonly kind: "page"; readonly pageId: string } }[]
}
export interface ManageActor extends ActorView { // opaque handle: frozen, minted only by authenticateManage
  readonly instanceId: string
  readonly audience: string                        // the manage audience that matched
  readonly issuer: string
  readonly subject: string
  readonly expiresAt: number                       // verified JWT exp, epoch seconds
}
export function authenticateManage(request: Request, deps: ManageDeps): Promise<ManageActor | null>
export function requireManageActor(actor: unknown, deps: ManageDeps): asserts actor is ManageActor // PolicyError("unauthenticated"), no D1 call

// domains/catalogue/commands.ts (S2)
export interface ManageDeps { readonly db: D1Database; readonly config: ManageInstanceConfig; readonly jwks: JwksSource; readonly now: () => number } // now: epoch ms
export interface PageTarget { readonly pageId: string; readonly artifactId: string; readonly expectedPolicyEpoch: number }
export type GrantMode = { readonly mode: "follow_active" } | { readonly mode: "pinned"; readonly revisionId: string }
export interface ShareResult { readonly grantId: string; readonly key: string | null; readonly mode: "follow_active" | "pinned"; readonly revealable: boolean; readonly policyEpoch: number }
export interface PagePolicyView {
  readonly pageId: string; readonly artifactId: string
  readonly visibility: "private" | "shared" | "public"; readonly policyEpoch: number; readonly contentVersion: number
  readonly grant: { readonly grantId: string; readonly mode: "follow_active" | "pinned"; readonly revisionId: string | null; readonly revealable: boolean } | null
}

export function readPagePolicy(deps: ManageDeps, actor: ManageActor, pageId: string): Promise<PagePolicyView | null>
export function setVisibility(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly visibility: "private" | "public" }): Promise<{ readonly policyEpoch: number }>
export function share(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & GrantMode): Promise<ShareResult>
export function rotateShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string; readonly next?: GrantMode }): Promise<ShareResult>
export function revokeShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string }): Promise<{ readonly policyEpoch: number }>
export function revealShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string }): Promise<{ readonly key: string }>
export function importShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly key: string; readonly mode: "follow_active" }): Promise<{ readonly grantId: string; readonly policyEpoch: number }>
export function setAlias(deps: ManageDeps, actor: ManageActor, cmd:
  | { readonly op: "put"; readonly kind: "redirect_exact" | "redirect_prefix"; readonly key: string; readonly to: string; readonly status: 301 | 302 | 307 | 308; readonly targetPageId: string | null }
  | { readonly op: "remove"; readonly kind: "redirect_exact" | "redirect_prefix"; readonly key: string }): Promise<void>
export function assignRole(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number; readonly role: "publisher" | "admin"; readonly scope: { readonly kind: "installation" } | { readonly kind: "page"; readonly pageId: string } }): Promise<{ readonly roleGrantId: string }>
export function revokeRole(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number; readonly roleGrantId: string }): Promise<void>
export function disablePrincipal(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number }): Promise<void>

// builders composed by Publication (F04) and import (F10) as executeGuarded effects
export function claimPageStatements(db: D1Database, p: { readonly pageId: string; readonly artifactId: string; readonly route: { readonly kind: "subtree"; readonly slug: string } | { readonly kind: "tree_page"; readonly pageRef: string }; readonly actorPrincipalId: string | null; readonly at: number }): readonly D1PreparedStatement[]
export function retirePageStatements(db: D1Database, p: { readonly pageId: string; readonly actorPrincipalId: string; readonly at: number }): readonly D1PreparedStatement[]
export function restorePageStatements(db: D1Database, p: { readonly pageId: string; readonly revisionId: string; readonly at: number }): readonly D1PreparedStatement[]

// domains/catalogue/revision-paths.ts (S2)
export interface RevisionPathConflict { readonly path: string; readonly reason: "reserved" | "shell" | "foreign_subtree" }
export function validateRevisionPaths(
  deps: { readonly db: D1Database; readonly config: ReadInstanceConfig | ManageInstanceConfig },
  input: { readonly artifactId: string | null; readonly paths: readonly string[]; readonly newSubtreeSlugs: readonly string[] },
): Promise<readonly RevisionPathConflict[]>
```

Behaviour (legacy transitions kept; Silex `functions/api/visibility.ts`, `functions/api/share.ts`; R `functions/api/visibility.ts`):

| Command | Effects after the guard |
|---|---|
| `setVisibility(private \| public)` | `pages.visibility`, `policy_epoch + 1`; revoke the active grant (`revoked_reason = 'visibility'`, sealed copy erased) |
| `share` (no active grant) | `visibility = 'shared'`, `policy_epoch + 1`; mint a key (§10), insert grant with HMAC and, if a seal key is configured, a sealed copy; return the key once |
| `share` (active grant) | no effect besides the audit row; the existing grant is returned unchanged (`key: null`, its `mode`, `revealable`) whatever mode was requested; changing the mode is a `rotateShare` with `next` |
| `rotateShare` | revoke the grant (`rotated`), insert a new grant with mode `next` if given (a pinned revision must belong to the artefact) else the same mode, `policy_epoch + 1`; return the new key |
| `revokeShare` | revoke the grant (`revoked`), `visibility = 'private'`, `policy_epoch + 1` (legacy `DELETE /api/share`) |
| `revealShare` | batch `[guard, SELECT sealed_key, seal_kid …]`; unseal outside the batch; return the key |
| `importShare` | admin only; `visibility = 'shared'`, `policy_epoch + 1`, insert grant `origin = 'imported'`, mode `follow_active`, HMAC of the exact legacy key, sealed copy if a seal key is configured |
| `setAlias` | Before any D1 call, the command checks four things, else `invalid_state`: `op` and `kind` are known values; `key` and `to` satisfy the redirect-route rules of §7 (same-origin visible-ASCII paths, checked by `isValidAliasPath` and `isValidAliasDestination`); a prefix key ends with `/`; the status is 301, 302, 307 or 308. It then inserts one redirect route (a key collision is a `conflict`) or deletes one. Deletion removes only redirect kinds, never a primary route |
| `assignRole` / `revokeRole` | insert or revoke a role grant; target `authority_epoch + 1` |
| `disablePrincipal` | `status = 'disabled'`, `disabled_at`, `authority_epoch + 1`; role rows kept but inert |
| `claimPageStatements` | insert page (`private`, epoch 0) then primary route; the document mount must already be in the batch |
| `retirePageStatements` | tombstone page, `policy_epoch + 1`, revoke its grant (`unpublished`), delete its primary route; aliases stay and stop resolving to a readable page |
| `restorePageStatements` | for a page proved tombstoned by its `restore_page` guard (same revision as `?17`): clear the tombstone, `visibility = 'private'`, `policy_epoch + 1`; insert its primary route derived from `revision_pages.document_path` (§9.4, plain `INSERT`); touches no grant, role, ownership edge or alias; the document mount must already be in the batch |
| ownership admission (`executeGuarded`'s `ownership`) | Multi-row `INSERT … SELECT` into `resource_owners`, at most 24 edges per statement, with the actor bound from the handle. Each edge's `admission` is computed in the same transaction, first match wins:<br>1. `forbidden` when the owner page and the revision belong to different artefacts.<br>2. `local` when the provider is that artefact.<br>3. `global` when the actor holds an active `admin` or installation `publisher` grant.<br>4. `preserved` when an identical edge (owner page, path, provider) is in the owner page artefact's current active revision, other than this one.<br>5. Otherwise `forbidden`.<br>The named CHECK `guard_forbidden` refuses `forbidden` and aborts the batch. A page publisher therefore keeps an existing cross-artefact edge but never adds or retargets one. Edges are written once per revision (primary key) and never updated |
| `validateRevisionPaths` | One primary read batch (instance marker, subtree routes). For each path:<br>- `/a/<slug>/…` is allowed only when `<slug>` is a subtree route of `artifactId` or in `newSubtreeSlugs`; a slug routed by another artefact → `foreign_subtree`, an unrouted slug → `reserved`;<br>- any other `isReservedShellPath` path → `reserved`;<br>- a configured shell path → `shell`.<br>Instance mismatch → `instance_mismatch`; D1 error → `unavailable`. F04 and F10 use it for manifest diagnostics (422); the guard's path claims stay authoritative |

Invariants kept by the commands and checked by tests: an active grant implies `visibility = 'shared'`; a pinned grant's revision belongs to the page's artefact.

### 9.1 Manage authentication and self-registration

`authenticateManage(request, deps)` is the only way to obtain a `ManageActor`:

1. It builds the manage verifier itself from `deps.config.accessTeamDomain` and `deps.config.manageAudiences` (surface `manage`) and calls `authenticate` with `deps.jwks` and `deps.now()` in seconds. No verified identity, or an empty `sub`, returns `null` with no D1 call.
2. It resolves the principal in one primary batch (self-registration, below). No principal returns `null`.
3. It returns a frozen handle, registered in a module-private `WeakSet`. The handle carries the principal's view, the instance ID, the matched manage audience, the issuer, the subject and the JWT expiry.

`requireManageActor(actor, deps)` accepts only a registered handle whose instance is `deps.config.instanceId`, whose issuer and audience are the configured ones, and that has not expired (`deps.now() < expiresAt × 1000`). Otherwise it throws `PolicyError("unauthenticated")` with no D1 call. Every command, `readPagePolicy` and `executeGuarded` calls it first, and a structurally identical object grants nothing. Role, status and epochs are still asserted on the primary by the guard or the policy read: the handle proves who signed in, not what they may do now. This is an API boundary against adapter forgery, not a defence against hostile code in the same isolate.

Self-registration (unguarded exception, §8.3) is one batch on the primary; the normative SQL is in [`principals.ts`](../domains/catalogue/principals.ts):

- `A0` reads the instance marker.
- `A1` inserts a new `active` principal with epoch 0 for `(issuer, subject)`, only when the marker equals the configured instance. It does nothing when the pair already exists (`ON CONFLICT (issuer, subject) DO NOTHING`).
- `A2` reads the principal for `(issuer, subject)`, and `A3` its active role grants.

- The instance verdict comes from `A0`: a mismatch throws `PolicyError("instance_mismatch")`. It is never inferred from `A1`'s `changes()`.
- `A2` and `A3` come from the same transaction. An existing principal is returned exactly as stored, including `status = 'disabled'`; it is never reactivated or modified. `DO NOTHING` is acceptable here only because no refusal is derived from it.
- Registration grants nothing: a new principal has no role until an administrator assigns one through the guard. No policy effect is ever composed into this batch.

### 9.2 Policy reads

`readPagePolicy(deps, actor, pageId)` is authorized inside Catalogue & Policy, never by an adapter. It first calls `requireManageActor` (no D1 call on failure), then runs one batch on the primary; the normative SQL is in [`read.ts`](../domains/catalogue/read.ts):

- `B0` reads the instance marker.
- `B1` reads the actor's status and authority epoch, and whether it holds an active `admin`, installation `publisher` or page `publisher` grant for the page. It also reads the live page with its artefact's `content_version` and active grant (mode, pinned revision, whether a sealed copy exists).

Decision order mirrors the guard: instance from `B0` (`instance_mismatch`) → actor active (`unauthenticated`) → actor epoch equals the handle's (`conflict`) → authorized (`forbidden`) → page live (`not_found`). An unauthorized caller learns nothing about the page. Commands use an internal, unexported snapshot helper for their prepare step (§8.3 rule 3); adapters never get an unauthorized policy read.

### 9.3 Publication commit composition

Publication's commit composition (normative example for F04; set-based so large artefacts stay within D1 limits):

```text
guards, exactly one per page, each binding :r as ?17 (path claims asserted):
  create_page   pages new in :r
  publish       live pages :r keeps
  restore_page  tombstoned pages of this artefact that :r contains (§9.4)
  unpublish     live pages :r drops
effects, in order:
  retirePageStatements for pages the new revision drops
  DELETE FROM mounts WHERE artifact_id = :a AND path NOT IN (SELECT path FROM revision_resources WHERE revision_id = :r)
  INSERT INTO mounts (path, artifact_id, revision_id, kind)
    SELECT path, :a, revision_id, kind FROM revision_resources WHERE revision_id = :r
    ON CONFLICT (path) DO UPDATE SET revision_id = excluded.revision_id, kind = excluded.kind
  claimPageStatements for new pages
  revision_pages rows of new pages (F04)
  restorePageStatements for pages guarded by restore_page
ownership (executeGuarded argument): edges of new pages, each covered by its create_page guard
finalEffects, in order:
  UPDATE artifacts SET active_revision_id = :r, content_version = content_version + 1 WHERE artifact_id = :a
  Publication receipt (F04 table)
```

The upsert is unconditional because the guard already refused any path mounted by another artefact or lying under another artefact's subtree; a kind change on a routed document fails the route foreign key (`invariant_violation`, after F04's manifest validation should have refused it as 422).

Sealing precedes the commit. The commit's guards read `:r` and its resources (`?17` path claims), so those rows must already exist. The work splits as follows:

- **Seal batch.** It carries `stage` guards, one per already existing page, bound to `:r`. Its effects write `revisions`, `revision_resources`, and the `revision_pages` rows of already existing pages.
- **Commit batch, effects.** The `revision_pages` rows of pages new in `:r` go here, after `claimPageStatements`, because a `revision_pages` row needs its page to exist.
- **Ownership edges.** The edges of `:r` are written once, as `executeGuarded`'s `ownership` argument, in the batch that writes their page's `revision_pages` row (seal or commit). They follow those effects and precede `finalEffects`, which hold the `active_revision_id` update and the receipt. Each edge needs that batch's guard for its owner page bound to `:r` (§8.3 rule 2), and its admission is decided in the same transaction (§9). A restore writes none.

A `stage` guard does not assert `:r`: the commit's `create_page`, `publish` or `restore_page` guard proves that `:r` belongs to the artefact, and each admission proves that page and revision share an artefact.

### 9.4 Restore composition

Restore (plan §3: a new promotion of a retained revision that reactivates no former share or revoked right) is a §9.3 commit whose `:r` is an existing revision of the artefact. Normative for F04:

- **Prepare (Publication).** Publication reads its own `artifacts.content_version` and the pages of `:r` from `revision_pages`, and proves through the Revision Store that the bytes of `:r` are still retained before building the batch. For each page of `:r`, `readPagePolicy` returning a view means live (`publish`, with that view's epochs); returning `null` means tombstoned, because `revision_pages` only references existing pages (`restore_page`). Live pages of the current active revision, if any, that `:r` does not contain get `unpublish`.
- **Batch.** The §9.3 order is unchanged: guards (exactly one per page), retire dropped pages, replace the artefact's mounts with the resources of `:r`, `restorePageStatements` for every `restore_page`, then `finalEffects` setting `active_revision_id = :r` with `content_version + 1`, and the receipt. This covers both a rollback of a live artefact whose `:r` contains pages dropped since, and the restore of a fully unpublished artefact, whatever its unpublish did with mounts or the active revision: the commit statements remount `:r` and make it active.
- **Identity.** Page IDs are those of `revision_pages`, never new ones; `create_page` stays refused (`conflict`) for a known ID. Ownership edges of `:r` already exist (immutable, keyed by revision), so a restore passes no `ownership` argument.
- **No reactivation.** A restored page comes back `private`, with no active grant, under a new policy epoch. Grants revoked at unpublish stay revoked with their reason, so former share links, share cookies and pinned proofs keep failing. Exposure returns only through an explicit guarded `setVisibility`, `share` (new key) or administrator `importShare`. `role_grants` are not touched: revoked roles stay revoked; an unrevoked page-scoped role keeps naming the same page ID.
- **Address.** The primary route is derived from `:r` (§7 note) and inserted plainly: if another page claimed it meanwhile, the whole batch fails as `conflict` (`routes` primary key) and nothing changes. A path mounted meanwhile by another artefact is refused by the guard's `?17` path-claim check. Aliases naming the page lead to it again for team readers once it is live (§12.5).
- **Authority and scope.** `restore_page` requires an administrator or an installation publisher: reclaiming a released address is an installation-level act, like `create_page` *(contract decision)*. With one guard per page, a page-scoped publisher can neither restore a revision that brings back a tombstoned page, even its own, nor drop pages outside its scope. Role commands and last-administrator protection are unchanged.

`restorePageStatements` is two statements; the normative SQL is in [`commands.ts`](../domains/catalogue/commands.ts):

1. An update of the page that clears the tombstone, sets `visibility = 'private'` and increments `policy_epoch`.
2. A plain `INSERT … SELECT` of its primary route from `revision_pages(?17, page)`. When the document path starts with `/a/`, the route has kind `subtree` with the slug of `/a/<slug>/index.html`; otherwise it has kind `tree_page` with the document path without its leading slash.

The `restore_page` guard proved, in the same transaction, that the page is tombstoned in this artefact and that `revision_pages` contains the page for that revision, so the `INSERT … SELECT` inserts exactly one row; no refusal is derived from a row count. The route's own CHECK and its foreign key to the document mount reject any inconsistent derivation as `invariant_violation`.

## 10. Share secrets (S2)

- Key grammar (both legacies): `^[A-Za-z0-9_-]{8,128}$`. New keys: 18 random bytes, base64url without padding (24 characters) *(contract decision; matches the Silex CLI length)*.
- Stored verifier: `key_hmac = hex(HMAC-SHA-256(verifierKey[kid], "forge.share.v1" ‖ 0x00 ‖ instanceId ‖ 0x00 ‖ key))`, with `key_kid`. Reads compute the HMAC under every configured verifier key and match `(kid, hmac)` pairs, so a verifier key can be rotated by adding a new current key while the previous one still verifies. Exact legacy keys are imported unchanged (`importShare`), so every historical URL keeps working.
- The same verifier keys also derive, under a distinct label, the key that signs pinned-read tokens (§12.6). They have no other use.
- Sealed copy: `base64url(iv ‖ AES-256-GCM(sealKey, key, aad))` with a 12-byte random IV and `aad = "forge.share.seal.v1" ‖ 0x00 ‖ instanceId ‖ 0x00 ‖ pageId ‖ 0x00 ‖ grantId`; stored only for active grants and erased on revocation (schema CHECK). The seal key exists only in the manage Worker; without it, minting and verification work and `revealShare` answers `invalid_state`.
- No column, log line, event, error or response other than the mint/rotate/reveal result contains a key. Tests assert it by scanning every table after each command.
- Share cookie (R, `shareCookie: true`): `forge_share=<encodeURIComponent(pageRef + "|" + key)>; HttpOnly; Secure; SameSite=Lax; Path=/`, no expiry (R `functions/s/[[path]].ts`). Parsing: regex `(?:^|;\s*)forge_share=([^;]+)`, URI-decode, split at the last `|`; the page part must be a valid tree route key ending in `.html` without `..`, the key must match the key grammar, otherwise the cookie is ignored. The cookie is revalidated against the current grant on every request; it never outlives a revocation, rotation, visibility change or unpublish. F05 emits it.

```ts
// domains/catalogue/share-secrets.ts (S2)
export function mintShareKey(): string
export function isShareKey(value: string): boolean
export function shareKeyDigests(keys: readonly ShareVerifierKey[], instanceId: string, key: string): Promise<readonly { readonly kid: string; readonly hmac: string }[]>
export function sealShareKey(seal: ShareSealKey, instanceId: string, pageId: string, grantId: string, key: string): Promise<string>
export function unsealShareKey(seal: ShareSealKey, instanceId: string, pageId: string, grantId: string, sealed: string): Promise<string>
```

## 11. Route grammar (S3)

### 11.1 Interfaces

```ts
// domains/catalogue/routing/grammar.ts (S3)
export type SubtreeOrTree =
  | { readonly kind: "subtree"; readonly slug: string }
  | { readonly kind: "tree_page"; readonly pageRef: string }

export type ParsedRequest =
  | { readonly kind: "deny"; readonly status: 403 | 404 | 405; readonly reason: "host" | "method" | "internal" | "malformed" }
  | { readonly kind: "shell"; readonly path: string; readonly login: { readonly next: string; readonly host: string } | null }
  | { readonly kind: "catalogue" }
  | { readonly kind: "subtree"; readonly slug: string; readonly candidates: readonly string[]; readonly next: string; readonly path: string }
  | { readonly kind: "tree"; readonly pageRef: string; readonly candidates: readonly string[]; readonly next: string; readonly path: string }
  | { readonly kind: "resource"; readonly path: string }
  | { readonly kind: "share"; readonly grammar: "slug" | "page"; readonly route: SubtreeOrTree; readonly key: string; readonly candidates: readonly string[]; readonly browser: boolean }
  | { readonly kind: "card"; readonly key: string; readonly targets: readonly { readonly route: SubtreeOrTree; readonly path: string }[] }
  | { readonly kind: "pinned"; readonly pageId: string; readonly revisionId: string; readonly path: string }

export interface RequestCredentials {
  readonly shareCookie: { readonly pageRef: string; readonly key: string } | null
}
export function parseRequest(request: Request, config: ReadInstanceConfig): { readonly parsed: ParsedRequest; readonly credentials: RequestCredentials; readonly aliasPath: string | null }
export function safeNext(raw: string | null, origin: string): string
export function loginLocation(next: string): string               // "/login" or "/login?next=<encoded>"
export function accessLoginLocation(config: ReadInstanceConfig, next: string, host?: string): string
export function canonicalUrl(route: SubtreeOrTree): string         // "/a/<slug>/", "/x/" or "/x/y"
export function shareUrl(config: InstanceBase, route: SubtreeOrTree, key: string): string
export function isReservedShellPath(path: string): boolean        // fixed namespaces only; independent of configured shellPaths
export function isReservedPath(path: string, config: InstanceBase & { readonly shellPaths?: readonly string[] }): boolean
export function subtreeSlugOf(path: string): string | null       // "/a/<slug>" or "/a/<slug>/…" with a valid slug, else null

// domains/catalogue/routing/outcome.ts (S3)
export type RouteOutcome =
  | { readonly kind: "deny"; readonly status: 403 | 404 | 405 | 503; readonly reason: string }
  | { readonly kind: "login"; readonly location: string }
  | { readonly kind: "redirect"; readonly status: 301 | 302 | 307 | 308; readonly location: string }
  | { readonly kind: "shell"; readonly path: string }
  | { readonly kind: "catalogue"; readonly viewer: "anonymous" | "team" }
  | { readonly kind: "serve"; readonly plan: ReadPlan }
  | { readonly kind: "share_exchange"; readonly plan: ReadPlan; readonly cookie: { readonly pageRef: string; readonly key: string }; readonly location: string }
  | { readonly kind: "share_unfurl"; readonly plan: ReadPlan; readonly pageRef: string; readonly key: string }
  | { readonly kind: "share_card"; readonly plan: ReadPlan }
export function toOutcome(parsed: ParsedRequest, decision: ReadDecision, identity: VerifiedIdentity | null, config: ReadInstanceConfig): RouteOutcome

// domains/catalogue/resolve.ts (S3)
export interface ReadDeps { readonly db: D1Database; readonly config: ReadInstanceConfig; readonly jwks: JwksSource; readonly nowSeconds: () => number; readonly pinnedProof?: string | null }
export function resolveRead(request: Request, deps: ReadDeps): Promise<RouteOutcome>
```

`resolveRead` = `authenticate` (read verifier) → `parseRequest` → one primary read batch → `toOutcome`. Content uses `decideRead`; shell and catalogue outcomes use `checkReadInstance` for their R0 check first. It is the only read entry point for Delivery.

`ParsedRequest.subtree.path` and `.tree.path` carry the normalized requested pathname so canonicalization occurs only after authorization, against the selected resource. `shell.login.host` carries the already-allowed request host, including an alias; it is passed to `accessLoginLocation` so login returns to that same host.

`ReadDeps.pinnedProof` is the opaque pinned-read token F05 carries; its transport is F05's. It defaults to `null`. `resolveRead` forwards it unparsed, with the same `nowSeconds` it used for `authenticate`. Only `decideRead` verifies it (§12.6); Routing and Delivery decide nothing about its validity.

### 11.2 Order and normalisation

1. Host (lowercased) ∉ `{canonicalHost} ∪ aliasHosts` → `deny 403 host` (covers `*.pages.dev`, `*.workers.dev`, previews). Aliases are served exactly like the canonical host.
2. Method ∉ {GET, HEAD} → `deny 405 method`.
3. Inspect the URL/path representation available at the `Request` API boundary. Still-visible `%2f`, `%2e` or `%5c` (any case), a backslash, a NUL or C0 control, an empty segment (`//`) or a `.`/`..` segment → `deny 404 malformed`; percent-decode segments strictly as UTF-8 and reject invalid encodings or decoded separators/dot segments. WHATWG URL parsing may already have removed literal dot segments, some percent-encoded dot segments, backslashes or controls before `Request.url` is exposed. F03 cannot recover or promise to reject an original ingress spelling that has disappeared. Its enforceable guarantee is rejection of still-observable malformed encodings plus confinement of the normalized effective path to the authorized page/subtree. A lost spelling is not an authorization bypass: routing and the SQL resource bounds apply to that effective path (R1/R4).
4. Internal paths → `deny 404 internal`: `/manifest.json`, `/asset-owners.json`, `/registry/*` (both legacies), `/api/*` except `/api/catalogue`.
5. Shell path (exact match in `shellPaths`) → `shell`. `/login` and `/login.html` carry `next = safeNext(searchParams.get("next"))` and the allowed request `host`.
6. `/api/catalogue` → `catalogue`.
7. `/_revisions/<pg_…>/<rv_…>/<rest…>` → `pinned` with `path = "/" + rest`; malformed IDs → `deny 404 malformed`.
8. `/s` or `/s/…` → share grammars (§11.4).
9. `/a` or `/a/…` with `"subtree"` enabled → subtree (§11.3).
10. `"tree"` enabled and the path is page-shaped → `tree`; otherwise → `resource`.
11. `"tree"` disabled → `resource` (team only; Silex "other static").

`isReservedShellPath(path)` is exported by S3 for S1 configuration validation. It recognizes the fixed content/API namespaces below, including `/a` and `/a/*`, but does not consult a configured shell list. Root, login, icons and configured `/_shared/*` files are therefore not rejected merely for being shell paths. `isReservedPath` is the separate content predicate: fixed namespaces plus configured shell paths.

Reserved namespaces for content paths (`isReservedPath`; F04 and F10 validate revision paths through Catalogue's `validateRevisionPaths`, §9, which adds the artefact's own-subtree exception with `subtreeSlugOf`): `/s`, `/s/*`, `/a/*` outside the artefact's own subtree, `/_revisions*`, `/api*`, `/registry/*`, `/manifest.json`, `/asset-owners.json`, `/cdn-cgi/*`, and the instance's shell paths. The schema refuses the instance-independent ones (§7).

`safeNext` is the union of both legacies: `raw` must start with `/` and contain no `..` (R); it is resolved with the URL parser against the origin; the origin must match; the resolved pathname must not start with `//`; it must not be `/login` or `/login.html` (Silex); the result is `pathname + search + hash`. `loginLocation(next)` returns `/login` when `next === "/"`, else `/login?next=<encodeURIComponent(next)>`. The value passed as `next` for protected pages is `pathname + search` (Silex; R dropped the query string; declared change §17).

`accessLoginLocation(config, next, host = config.canonicalHost)` (R `/login` without a verified identity, `login: "redirect-access-login"`): `https://<accessTeamDomain>/cdn-cgi/access/login/<request host>?redirect_url=<encodeURIComponent(absolute next)>`. The optional host must be the already-allowed request host from `shell.login.host`; both the Access login path and the absolute return URL use it, preserving alias-host login. With `serve-shell` the login shell is served (Silex: Access intercepts `/login` first).

### 11.3 Subtree and tree grammars

Subtree (Silex `functions/_lib/access.ts` `extractSlugFromAPath`, `SLUG_RE`): `/a/<slug>` or `/a/<slug>/<rest…>` with slug `^[a-z0-9]+(-[a-z0-9]+)*$`; otherwise `deny 404 malformed`. Candidates for the resource, in order:

| Request form | Candidates | Served form |
|---|---|---|
| `/a/<slug>` | `/a/<slug>/index.html` | 308 → `/a/<slug>/` (observed, OS-3) |
| `/a/<slug>/` | `/a/<slug>/index.html` | 200 (observed, OS-3) |
| `/a/<slug>/index.html` | same path | 308 → `/a/<slug>/` (observed, OS-3) |
| `/a/<slug>/index` | `/a/<slug>/index.html` | 308 → `/a/<slug>/` (observed, OS-3) |
| `/a/<slug>/<p>/` | `/a/<slug>/<p>/index.html` | 200 † |
| `/a/<slug>/<p>/index.html`, `/a/<slug>/<p>/index` | `/a/<slug>/<p>/index.html` | 308 → `/a/<slug>/<p>/` † |
| `/a/<slug>/<p>.html` (last segment not `index.html`) | same path | 308 → `/a/<slug>/<p>` † |
| `/a/<slug>/<p>` (last segment without a dot, not `index`) | `/a/<slug>/<p>`, `/a/<slug>/<p>.html`, `/a/<slug>/<p>/index.html` | 200 for the first two; 308 → `/a/<slug>/<p>/` for the third † |
| other `/a/<slug>/<file>` | exact path | 200 |

Subtree rule: a request that resolves to a directory's `index.html` through any form other than the directory itself (`index.html`, extensionless `index`, or the directory without its trailing slash) answers 308 to `<directory>/`; only `<directory>/` is served 200. The four slug-root rows are observed (OS-3: anonymous, no cookie, redirects not followed; every response `no-store`, no `Set-Cookie`). † Pages route-matching rule below the slug root, not yet observed: no nested public vector has been exercised yet (missing evidence, not proof that no such file exists); an observation that differs changes the row first.

Tree (R `functions/_middleware.ts` `treePageId`): only paths whose segments match `[A-Za-z0-9._-]+` and that are not shell, `/api/`, `/s/` or `/a/` paths are page-shaped:

| Request form | Page ref (R `treePageId`) | Outcome once authorized | Evidence |
|---|---|---|---|
| `/x/y.html` | `x/y.html` | 308 → `/x/y` | R source (308 in its comment); Pages doc documents the redirect, not its status |
| `/x/y` (last segment without a dot) | `x/y.html` | 200 | R source; Pages doc |
| `/x/y/` | `x/y/index.html`, a distinct page from `x/y.html` | 200 | R source |
| `/x/y/index.html` | `x/y/index.html` | 308 → `/x/y/` | R source (308 in its comment); Pages doc documents the redirect, not its status |
| `/x/y/index` | `x/y/index.html` | 308 → `/x/y/` | R source mapping; Pages directory-index redirect observed on Silex (OS-3) |
| `/d` (last segment without a dot) | `d.html` only, never `d/index.html` | as `/x/y` | R source |

The redirect forms follow the official Pages route-matching rule ([Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/#route-matching): `/contact.html` → `/contact`, `/about/index.html` → `/about/`), which documents the redirect but not its status. The 308 status comes from the expectation in R's pinned source comment (`treePageId`), and for the `index` form from the Silex OS-3 observation, not from that documentation alone. No eligible public tree document exists in the inspected Roxabi deployment, so every tree row is a source-derived expectation, not a deployed-instance observation (OR-1, §13). Identities are never merged: `x/y.html` and `x/y/index.html` are distinct pages, `/d` names `d.html`, and no candidate falls back to another form. An unknown identity follows §12 (anonymous → login, team → `not_found`). They are issued only after the read decision allows the request, as in legacy where the middleware runs before asset handling. Anything else is `resource` (asset-shaped). A page-shaped path that is not a page route but is a mounted fragment is decided as a fragment (§12).

Legacy can hold a public visibility record whose file is absent. The OR-1 counterexample shows a Pages 404 HTML page for the `.html` and extensionless forms, and a login redirect for the trailing-slash form, which names another identity. The engine cannot represent that state, because a route requires a mounted document (§7). The resulting HTTP difference remains open for F05/F10/F13 (§13). It is resolved or explicitly accepted there, never silently normalized here.

### 11.4 Share grammars

All share failures answer `deny 404` with no fallthrough to another grammar once one has claimed the request (R `functions/s/[[path]].ts`).

1. **Keyed tail** (R `parseKeyedTail`): segments after `/s/` non-empty; key = last segment (key grammar); identity = the other segments joined by `/`, each matching `[a-zA-Z0-9._-]`.
2. **Page key** (`"page"`): identity ends in `.html` and matches the tree route-key grammar → `share` grammar `page`, route `tree_page`, candidates `["/" + identity]`, `browser = (Sec-Fetch-Dest === "document")`.
3. **Card** (`"card"`): identity is a card name (R `pagesForCard`: `og.{jpg,jpeg,png}` beside a tree index or a slug directory, `<stem>.og.<ext>` beside `<stem>.html`) → `card` with each candidate route and the card path. No candidate → fall to 4.
4. **Slug** (`"slug"`, Silex `functions/_lib/share-path.ts` `parseShareRoute`): with no `k` query parameter and at least two segments: `slug = seg[0]`, `key = seg[1]`, `rest = seg[2…]`; with a `k` query parameter and at least one segment: `slug = seg[0]`, `key = k`, `rest = seg[1…]`. Slug grammar as subtree; each `rest` segment matches `[a-zA-Z0-9._-]`. Candidate (Silex `shareAssetPath`): `rest` empty → `/a/<slug>/index.html`; last `rest` segment contains a dot → `/a/<slug>/<rest>`; else `/a/<slug>/<rest>/index.html`. No canonical redirects inside `/s/`. Observed one level deep (OS-2) for an existing shared child document: `/s/<slug>/<key>/<child>.html` → 200 HTML; `/s/<slug>/<key>/<child>`, `<child>/` and `<child>/index.html` → 404 `Not found`, because the candidate is `/a/<slug>/<child>/index.html` and there is no `.html` inference; all `no-store`, no redirect, no `Set-Cookie`. Depth ≥ 2 follows the same source rule † (confirmed by real HTTP before F14).

### 11.5 Outcome mapping

| Decision | Subject | Outcome |
|---|---|---|
| `instance_mismatch`, `unavailable` | any | `deny 503` |
| `allow` | subtree, tree, resource, pinned | `serve`, or `redirect 308` to the served form (§11.3) |
| `allow` | share slug; share page with `browser = false` | `serve` (slug) · `share_unfurl` (page, F09) |
| `allow` | share page with `browser = true` | `share_exchange`: 302 to `canonicalUrl` with the share cookie (F05) |
| `allow` | card | `share_card` (F09) |
| `login_required` | subtree, tree | `login` with `loginLocation(next)` |
| `not_found` | any | `deny 404` |
| alias found, team identity, target live or absent (§12.5) | any unclaimed path | `redirect` with the alias status |
| shell `/login` with a read identity | — | `redirect 302` to `next` |
| shell `/login` without identity, `redirect-access-login` | — | `redirect 302` to `accessLoginLocation` |

`deny 404` renders the legacy body `Not found`, `content-type: text/plain; charset=utf-8`, `cache-control: no-store`, `x-robots-tag: noindex, nofollow`. Every controlled response is `no-store`. Header names and values are F05's; the legacy `x-forge-acl: vis-v4` marker is not reused as proof of the new model.

## 12. Read decisions (S2)

```ts
// domains/catalogue/read.ts (S2)
export type ReadSubject =
  | { readonly kind: "page"; readonly route: SubtreeOrTree; readonly candidates: readonly string[]; readonly fragmentPath: string | null }
  | { readonly kind: "resource"; readonly path: string }
  | { readonly kind: "share"; readonly route: SubtreeOrTree; readonly candidates: readonly string[] }
  | { readonly kind: "card"; readonly targets: readonly { readonly route: SubtreeOrTree; readonly path: string }[] }
  | { readonly kind: "pinned"; readonly pageId: string; readonly revisionId: string; readonly path: string }
export interface ReadCredentials {
  readonly team: VerifiedIdentity | null       // counts only if registered, read surface, read audience, unexpired (§12.1)
  readonly shareKey: string | null             // from a share grammar
  readonly shareCookie: { readonly pageRef: string; readonly key: string } | null
  readonly pinnedProof: string | null          // opaque token, verified here (§12.6)
  readonly nowSeconds: number
}
export interface ReadPlan {
  readonly instanceId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly resource: { readonly path: string; readonly kind: "document" | "subdocument" | "fragment" | "asset"; readonly objectKey: string; readonly sha256: string; readonly size: number; readonly contentType: string }
  readonly requestedPath: string | null        // candidate that matched; null when exact
  readonly authority: { readonly basis: "team" | "public" | "public_owner" | "share_key" | "share_cookie" | "pinned"; readonly pageId: string | null; readonly grantId: string | null; readonly policyEpoch: number | null }
  readonly pinnedProof: string | null          // minted here after an allow (§12.6)
  readonly cache: "no-store"
}
export type ReadDecision =
  | { readonly kind: "allow"; readonly plan: ReadPlan }
  | { readonly kind: "deny"; readonly reason: "not_found" | "login_required" | "instance_mismatch" | "unavailable" }
  | { readonly kind: "alias"; readonly status: 301 | 302 | 307 | 308; readonly location: string }
export function decideRead(db: D1Database, config: ReadInstanceConfig, subject: ReadSubject, credentials: ReadCredentials, aliasPath: string | null): Promise<ReadDecision>
export function checkReadInstance(db: D1Database, config: ReadInstanceConfig): Promise<ReadDecision | null> // R0 only; null means matching instance, otherwise deny

// domains/catalogue/catalogue-list.ts (S2)
export interface CatalogueEntry { readonly pageId: string; readonly url: string; readonly visibility: "private" | "shared" | "public" | null; readonly metadata: unknown }
export function listCatalogue(db: D1Database, config: ReadInstanceConfig, viewer: "anonymous" | "team", page: { readonly after: string | null; readonly limit?: number }): Promise<readonly CatalogueEntry[]>
```

### 12.1 Execution rules

- One `db.batch([...])` per request: `R0` plus the statements the subject needs. Shell/catalogue route outcomes use `checkReadInstance` (R0-only batch, `null` on match, deny on mismatch or D1 error) rather than skipping the marker check. A batch is one transaction, so every fact comes from one snapshot of the primary. No `withSession()`, no KV, no cache.
- Any D1 error → `unavailable` (503, no-store). `R0` mismatch → `instance_mismatch` (503). No fallback.
- Share keys and cookie keys are turned into `(kid, hmac)` pairs before the batch; unused pairs are bound to `NULL`.
- A team identity counts only when `isVerifiedIdentity(team)` holds (§5), its surface is `read`, its audience is in `readAudiences`, and `nowSeconds < expiresAt`. Otherwise the request is decided as having no team identity. A pinned token is verified before the batch (§12.6); an invalid one is no proof.
- The decision completes before any byte, `HEAD`, `Range` or conditional answer is produced (F05).

Statements; the normative SQL is in [`read.ts`](../domains/catalogue/read.ts) and [`catalogue-list.ts`](../domains/catalogue/catalogue-list.ts):

| Statement | Reads |
|---|---|
| `R0` | the instance marker |
| `R1` page by route (page, share and card subjects) | The live page of the route, provided its artefact has an active revision, with its visibility and policy epoch. The active grant matching one of the share-key `(kid, hmac)` pairs. The active `follow_active` grant matching the cookie pairs, when the route is the cookie's tree page. Each candidate resource (at most three) of the active revision or of the key grant's pinned revision that passes the confinement rules below |
| `R2` fragment or asset by mount | The current mount of the path, of kind `fragment` or `asset`, whose revision is its artefact's active revision, with its bytes. Whether a live public owner page has, in its active revision, an edge to the path whose provider is the mounting artefact. The `follow_active` grant of a live shared owner page that meets the same edge conditions and matches the cookie pairs on the cookie's tree page |
| `R3` alias | the exact redirect for the path, else the longest matching prefix redirect, with whether its target page is live |
| `R4` pinned | The live page with its primary route. The requested revision, when it belongs to the page's artefact and contains the page. The active grant named by a verified token. The resource selected by the confinement rules below |
| `R5` catalogue | Live pages whose artefact has an active revision containing them, with primary route, visibility and the active revision's `metadata_json`. Public pages only for an anonymous viewer. Ordered by page ID after the cursor, limited |

Resource confinement is part of the Catalogue decision, not a promise made by the parser or Delivery:

- **Membership.** A resource row is read for a page only from a revision that contains that page (`revision_pages`). This holds for R1 (active revision or pinned key grant) and R4 alike. A resource of the active revision must also be the artefact's current mount of that path and kind.
- **Local first (R4).** When the requested revision itself holds the path, that row is the only candidate. An external mount is considered only when it does not.
- **By kind**, for a local resource (R1 and R4):
  - `document`: only the page's own document (`revision_pages.document_path`; for R1 also the route's document);
  - `subdocument`: only for a subtree page, under the exact `/a/<slug>/` prefix;
  - `fragment` or `asset`: for a subtree page, under the exact prefix only (an edge never widens it); for a tree page, only with an ownership edge `(revision, page, path)` whose provider is the page's own artefact.
- **External (R4 only).** For a tree page, a `fragment` or `asset` that the revision does not hold is read only through an edge `(revision, page, path, provider Y)`, where Y is not the page's artefact. It is read only from Y's current mount of the path, with matching kind and `mounts.revision_id` equal to Y's active revision. A missing or stale mount, or a mount by any artefact other than Y, denies. The resource follows Y's active revision, while local bytes never fall forward to a newer revision of the page's artefact.
- An ownership edge never opens a `document` or `subdocument`, whoever reads (team, share key or token). Candidate membership (`rr.path IN …`) alone never grants access, and a sibling document inside the subtree prefix is excluded.
- `ReadPlan.artifactId` and `ReadPlan.revisionId` identify the resource bytes selected for Store; for an external resource, these are the providing artefact and its active revision. The authority remains the requesting page, and the token remains bound to that page, its requested revision and its current policy epoch. An external resource's revision is never compared with the token's revision.

### 12.2 Page, subtree and tree

From `R1` (no row → route unknown):

| Viewer and state | Subtree (Silex and R `/a/`) | Tree page (R) |
|---|---|---|
| route unknown, no team identity | `login_required` | `login_required` (if a fragment is mounted at the path, §12.3 decides instead) |
| route unknown, team | `not_found` | `not_found` (or §12.3) |
| team | allow, active revision | allow, active revision |
| share cookie grant on this page (`follow_active`, page shared) | not applicable | allow |
| visibility public | allow | allow |
| visibility shared, no valid cookie | `not_found` | `login_required` |
| visibility private | `login_required` | `login_required` |
| allowed but no candidate exists in the revision | `not_found` | `not_found` |

### 12.3 Fragments and assets

From `R2` (no row → `not_found` for everyone; an asset-shaped path never redirects to login):

| Order | Rule | Result |
|---|---|---|
| 1 | team identity | allow |
| 2 | a live shared owner page, under the edge conditions of row 3, whose follow-active grant matches the share cookie | allow |
| 3 | a live public owner page whose active revision has an edge to the path naming the mounting artefact as provider | allow |
| 4 | otherwise, including orphans (no owner) | `not_found` |

Subtree paths are never decided here: under `/a/<slug>/` the subtree page decides. A document or subdocument is never reachable through this rule (`m.kind IN ('fragment', 'asset')`).

### 12.4 Share, card and pinned reads

- **Share** (`R1` with the key pairs): allow only if visibility is `shared` and `key_grant_id` is set. A team identity does not bypass a share URL. Revision = the grant's pinned revision when `mode = 'pinned'`, else the active revision. Otherwise `not_found`.
- **Card**: `R1` per target in the same batch; the first target whose page allows by share key and whose card path exists in the chosen revision with `content_type` starting `image/` wins; else `not_found`.
- **Pinned** (`R4`): the page must be live and contained in the requested revision, and the path must pass the confinement rules above. Two conditions must then both hold:
  - The basis holds now: a team identity (§12.1); or visibility `public`; or the token's grant is active on the page, the page is `shared`, and the grant is `follow_active` or pinned to this revision.
  - The revision is reachable: it is the active one, or the grant is pinned to it, or a valid token (§12.6) names this page, this revision and the current `policy_epoch`.

  Anything else is `not_found`. Old revisions are not readable merely because they are known or because the page is public now.

### 12.5 Aliases and catalogue

- `R3` is consulted for paths no grammar claimed (unknown subtree or tree route, unmounted resource). Only a team identity gets the alias redirect, and only when `target_page_id IS NULL OR target_live`: an alias naming a page redirects only while that page is live; an alias naming none (historical `_redirects` entries) always redirects a team identity, as legacy Pages applied `_redirects` to team requests. A redirect grants no authorization: its `Location` is a same-origin path (route CHECK), and the request that follows it is decided on its own. Every other viewer — anonymous or holding a share cookie — gets the outcome the path would have had without the alias, never a redirect. For the historical aliases that outcome is `deny 404` (`Not found`, `text/plain; charset=utf-8`, `no-store`, no `Set-Cookie`, no `Location`), as observed in OS-4. The 404 comes from the path, not from the alias. Every historical alias key is a path that no page grammar claims: none is under `/a/`, and Silex has no tree grammar. R2 therefore finds no row (§12.3). An alias never changes a non-team outcome. An alias key that is also route-shaped, such as an unknown subtree or tree route, keeps that route's outcome, `login_required` included (§12.2). The team redirect is inferred from Pages applying `_redirects` after the middleware passes, not observed.
- `R5`: anonymous viewers list public pages only; team viewers list all live pages with their visibility. No share key, grant or principal data is listed. `limit` defaults to 50; an integer is clamped to 1–100; a non-integer is `PolicyError("invalid_state")` with no D1 call. An instance mismatch throws `PolicyError("instance_mismatch")` and a D1 error `PolicyError("unavailable")`, both 503 `no-store`. There is no partial or fallback list. `metadata_json` keys are defined by F05 (catalogue) and F04 (publish input).

### 12.6 Pinned-read token

Plan §2.3: a pinned read gets a short proof bound to its page, revision and read right, with no publishing power. ACL, revocation and expiry are rechecked on every request.

- **Minting.** Only `decideRead`, on the same code path and right after an allow, sets `ReadPlan.pinnedProof`. It does so for a `document` or `subdocument` whose authority has a page and a policy epoch and whose basis is `public`, `team`, `share_key` or `share_cookie`; share bases become basis `grant` with the grant ID. Basis `pinned` and every other plan carry `null`, and Delivery keeps the token it was given. No exported function mints a token, signs a payload or exposes the derived key, so a fabricated `ReadPlan` mints nothing.
- **Format** *(contract decision)*: `v1.<kid>.<payload>.<mac>`, at most 1024 characters, base64url without padding.
  - The payload is UTF-8 JSON with keys in this order: `v` (1), `i` instance, `p` page, `r` revision, `e` policy epoch, `b` basis (`public`, `team`, `grant`), `g` grant ID or `null`, `x` expiry (`nowSeconds + 900`, epoch seconds).
  - `mac = HMAC-SHA-256(Kp, "forge.pinned.v1" ‖ 0x00 ‖ payload)`, with `Kp = HMAC-SHA-256(verifierKey[kid], "forge.pinned.key.v1")`. This is a domain-separated derivation from the share verifier keys (§10), not a new secret.
  - Minting uses the first configured key. Verification accepts any configured `kid`, so removing a key invalidates its tokens.
- **Verification** happens in `decideRead`, before the batch:
  - strict parse, known `kid`, and a constant-time MAC check (`crypto.subtle.verify`);
  - `nowSeconds < x`;
  - instance equal to the configuration; page and revision equal to the `/_revisions/` route.

  Then, on the primary: `e` equals the page's current `policy_epoch`, the revision contains the page, and the basis holds now (§12.4). Any failure means no token, never an error.
- **No right of its own.** A token only makes its revision reachable for the page (§12.4). It never replaces the basis, which is rechecked on every request:
  - `team` requires a valid verified read identity on that very request, so a team token presented without one, or after the read JWT expired, reads nothing;
  - `grant` requires the grant to be active and to match, and the current policy epoch;
  - `public` requires the page to be public now.
- **Lifetime** *(contract decision)*: `x` bounds revision reachability to 900 s and extends no right beyond its basis. Every visibility, grant, unpublish or restore change moves the policy epoch, which invalidates earlier tokens at once.
- Delivery only transports the token and rewrites `/_revisions/` URLs (F05). A token never authorizes a mutation, and a token for one page never opens another page.

## 13. Empirical parity observations

Protocol for the parent (metadata only): GET or HEAD from the parent's controlled session, no cookie or Authorization on artefact hosts unless the case says team, redirects not followed. Record status, `Location` as a path template with keys and slugs replaced, `content-type`, `cache-control`, presence of `Set-Cookie` and its attribute names, body length, and digest equality against a reference response — never a key, client or artefact name, slug, digest or body in public git. Results go to `docs/forge-convergence-status.md` (parent-owned).

| ID | Instance | Case | Status | Blocks |
|---|---|---|---|---|
| OS-1 | Unkillable | `/s/<slug>/<key>/`, `/s/<slug>/<key>/index.html`, `/s/<slug>/?k=<key>` with a current key | **Observed 2026-11-12**: all three 200 with the same HTML body, `no-store`, no `Set-Cookie`, no redirect. Wrong key → 404 `Not found` (`text/plain; charset=utf-8`, `no-store`). Anonymous `/a/<shared slug>/` → the same 404. Encoded in §11.4 and §12.4. | — |
| OS-2 | Unkillable | Under a shared slug: an existing one-level shared child document `/s/<slug>/<key>/<child>.html`, `<child>`, `<child>/`, `<child>/index.html`; deeper `<d>/<f>` forms; `/s/<slug>/<key>/<asset>` | **Partially observed** (private record `F03-silex-OS2-shared-child-observations`; namespace and current key checked by GET only): `<child>.html` → 200 HTML, no redirect, no `Set-Cookie`; `<child>`, `<child>/`, `<child>/index.html` → 404 `Not found` (`text/plain`); all `no-store`. Matches §11.4. Depth ≥ 2 not exercised; the absence of deep live files is not established. Asset bytes are served by F05, not F03. | F03: source rule, observed child vectors, deterministic real-D1 deep-confinement tests (T5); deep and asset share forms by real HTTP before F14 (†) |
| OS-3 | Unkillable | Public slug: `/a/<slug>`, `/a/<slug>/`, `/a/<slug>/index.html`, `/a/<slug>/index` | **Observed** (private record `F03-silex-OS3-OS4-http-observations`): 308 → `/a/<slug>/`, 200 HTML, 308 → `/a/<slug>/`, 308 → `/a/<slug>/`; all `no-store`, no `Set-Cookie`. Nested public forms not yet exercised; the absence of public nested files is not established. Encoded in §11.3. | nested subtree confirmation only (before F14) |
| OS-4 | Unkillable | Anonymous request on three historical alias forms in `site/_redirects`: an exact or prefix root, an unknown child under a prefix alias, a file alias (the parent keeps the exact private requests) | **Observed**: all 404 `Not found` (`text/plain; charset=utf-8`), `no-store`, no `Set-Cookie`, no redirect. Encoded in §12.5. | — |
| OR-1 | Roxabi | Public tree page forms: `/x/y.html`, `/x/y`, `/x/y/`, `/d/index.html`, `/d/index`, `/d/`, `/d` | **Present content not observable; replaced for F03 by the operator-approved evidence amendment below** (private record `F03-OR1-method-operator-approval`). A fresh read-only inspection of the canonical deployment found 61 visibility records (59 public, 1 shared, 1 private). It served 16 canonical files, 5 of them HTML (3 shell, 2 `/a/<slug>/index.html`). None of the public refs intersects the served files, so no eligible public tree document is present. Missing-path counterexample, for a public ref whose file is absent (anonymous, no cookie, redirects not followed): `.html` form → 404 HTML; extensionless form → the same 404 body; extensionless with a trailing slash → 302 to login. All responses are `no-store` without `Set-Cookie`. | F03: source-derived vectors (T15). Historical tree URL and access parity: F10 fidelity, mandatory before F13 |
| OR-2 | Roxabi | The current share key: identity kind (slug or page); browser request (`Sec-Fetch-Dest: document`) → status, `Location` template, `Set-Cookie` attributes; non-browser → status and content-type | pending | F05/F09 parity (not F03 code) |
| OR-3 | Roxabi | Anonymous `/_shared/hero-base.css` and `/login` (status, `Location` host and path template) | pending | shell paths and login mode values (F11 config) |

**OR-1 — operator-approved F03 evidence amendment** (approved before merge; private record `F03-OR1-method-operator-approval`). The inspected current canonical Roxabi deployment contains no eligible public tree document. Present-content production canonicalization therefore remains unobserved. Before the F03 PR merges, the tree identity, authorization and canonicalization expectations of §11.3 must be encoded from three sources: the pinned R source (§1, `treePageId`), the official Pages route-matching rule, and real-D1 tests through real `Request`/`URL` objects (T15). The missing-path counterexample is kept as a distinct vector, never counted as a present-content observation. A source-exact local Pages HTTP run is optional complementary evidence, labelled local, never deployed-instance parity. F03 asserts decisions only; real headers belong to F05. The gap between the observed legacy 404 HTML for a public ref without bytes and the engine outcome stays open for F05/F10/F13, resolved or explicitly accepted there, never silently normalized. Historical tree URL and access parity remains open for F10 fidelity acceptance and is mandatory before F13 cutover. G1b is unchanged and blocks historical-corpus import. This amendment removes no path or ACL criterion and authorizes no production, legacy or Shlink mutation. OS-2 is accepted for F03 on the Silex source rule (§11.4), the observed one-level child vectors and deterministic real-D1 tests of deep confinement (T5); deep (depth ≥ 2) and asset share forms are confirmed by real HTTP before the F14 parity gate, like OS-3 †. No grammar or acceptance criterion is removed. OS-3 slug-root forms and OS-4 are encoded now. Nested public subtree forms follow the Pages rule (§11.3 †) and are confirmed before the F14 parity gate by an exercised nested public vector. An observation that differs changes the corresponding table row in this document first.

## 14. Slices, file ownership and tests

One worktree, one branch `feat/F03-core-contract`, one PR. Each file has one owner. Slices code against the interfaces above; a needed interface change goes through this document's owner first.

| Path | Owner | Content |
|---|---|---|
| `docs/forge-core-contract.md`, `docs/architecture/adr/0001-*.md`, `docs/architecture/adr/0002-*.md`, `GLOSSARY.md` | architect | this contract, decision records, vocabulary |
| `package.json`, `package-lock.json` | S1 | `vitest` ^4.1, `@cloudflare/vitest-plugin` ^1.8.1 (its peer range requires Vitest ≥ 4.1); `typecheck` runs both TypeScript projects |
| `vitest.config.ts` | S1 | `test.projects`: `legacy` (node, `tests/*.test.ts`, existing alias) and `engine` (`cloudflareTest()` workers pool, `tests/engine/**/*.test.ts`, D1 binding `DB`, `TEST_MIGRATIONS` from `readD1Migrations("migrations")`) |
| `tsconfig.json` | S1 | exclude `tests/engine/**`; the legacy project keeps `functions/**` and `tests/*.ts` |
| `tsconfig.engine.json` | S1 | `domains/**/*.ts`, `tests/engine/**/*.ts`, workers and `cloudflare:test` types, strict |
| `tests/engine/setup/apply-migrations.ts`, `tests/engine/env.d.ts` | S1 | `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`; `ProvidedEnv` typing |
| `.dev/stack.yml` | S1 | engine paths in the stack description; remove the note that the axial review has no path hit |
| `.github/workflows/ci.yml` | S1 | only if the workers pool needs a Node or runtime adjustment in the existing `test` job; release and activation gates untouched |
| `domains/catalogue/instance-config.ts` | S1 | §4 |
| `domains/catalogue/identity.ts` | S4 | §5 |
| `migrations/0001_catalogue.sql` | S2 | §7 rules (normative SQL) |
| `domains/catalogue/ids.ts` | S2 | ID mint and validation (§3) |
| `domains/catalogue/guard.ts` | S2 | §8 |
| `domains/catalogue/principals.ts`, `domains/catalogue/commands.ts`, `domains/catalogue/alias-validation.ts`, `domains/catalogue/revision-paths.ts` | S2 | §9 |
| `domains/catalogue/share-secrets.ts` | S2 | §10 |
| `domains/catalogue/read.ts`, `domains/catalogue/catalogue-list.ts`, and any key-free pinned-token helper | S2 | §12 |
| `domains/catalogue/routing/grammar.ts`, `domains/catalogue/routing/outcome.ts`, `domains/catalogue/resolve.ts` | S3 | §11 |
| `LICENSE` | S3 | add the Roxabi copyright line (§16) |
| `tests/engine/**/*.test.ts`, `tests/engine/fixtures/**` | R-tester | behavioural tests below |
| `AGENTS.md` (engine section), `CHANGELOG.md`, `docs/forge-convergence-status.md` | parent | integration, changelog, observation results, delivery state |

Interface coordination: S2 uses S1 config types and S4's `VerifiedIdentity`; S3 composes those interfaces. S1 also imports S3's pure `isReservedShellPath`, so slice numbers are not an acyclic import ordering. That shared predicate does not parse configuration or inspect the configured shell list; routing consumes configuration types without calling the configuration parser. S3 owns the predicate, S1 reuses it instead of duplicating it. Legacy `functions/`, `site/`, `plugins/`, root `wrangler.toml` and the existing `tests/*.test.ts` files are untouched; the legacy suite must stay green under the upgraded Vitest.

Test rules (R-tester): real D1 through the workers pool with migrations applied, no fake D1, no mocked guard. JWTs are signed in-test with WebCrypto-generated RSA keys and served through an injected `JwksSource`. Fixtures create pages and routes through `claimPageStatements` and write F04-owned rows (`artifacts`, `revisions`, `revision_resources`, `revision_pages`, `mounts`) with plain SQL until F04 exists. Ownership edges are written only through `executeGuarded`'s `ownership` argument, with a real `ManageActor` from `authenticateManage`, never by plain SQL into `resource_owners`. Pinned tokens come from a real `decideRead` allow. D1 failure is exercised with a real binding whose schema is absent (D1 raises a genuine error).

| # | Behaviour |
|---|---|
| T1 | Instance: missing or different `instance_meta` → every read `instance_mismatch`, every guard `instance_mismatch`. |
| T2 | Subtree parity (Silex): anonymous public serve; private and unknown → `/login?next=` with path and query; shared → 404; team reads all; team unknown → 404; tombstoned behaves as unknown. |
| T3 | Tree parity (R): only the canonical equivalents of one identity reach that page (§11.3). `x/y.html` ← `/x/y.html` (308 → `/x/y` once authorized) and `/x/y`; `x/y/index.html` ← `/x/y/`, `/x/y/index.html` and `/x/y/index` (308 → `/x/y/` once authorized). Trailing-slash or index forms and non-index forms are never merged: `/x/y/` never reaches `x/y.html`, and `/d` names `d.html`, never `d/index.html`. For each identity: anonymous viewers get public pages served, while private pages and shared pages without a cookie → login; a cookie grant serves; a revoked, rotated, visibility-changed or unpublished cookie → denied on the next request; team reads all. |
| T4 | Fragments and assets: public owner opens; cookie owner opens; closed → 404 never login; orphan → 404; ownership across artefacts; a page document mounted as fragment is refused by the schema. Direct `decideRead` calls with a public or share-authorized page and a sibling document in `candidates` must deny: candidate membership, a team identity, or a forged ownership edge cannot widen the authorized page. Subtree resources must remain inside the exact subtree prefix. An edge is bound to its provider. A public owner page's edge to a path provided by artefact Y opens Y's current mount. After Y drops the path and artefact Z mounts it, the same edge opens nothing for anonymous and cookie viewers. A forged edge to a sibling document never opens it. |
| T5 | Slug share: path and query forms, explicit index; wrong key, other page's key, non-shared page, revoked key → 404; team identity gets no bypass on `/s/`; still-visible malformed encodings/separators → 404; paths already normalized by a real Request are tested for effective route confinement, not recovery of their lost wire spelling; `rest` confined to the slug's subtree. OS-2 one-level vectors: `<child>.html` → 200; `<child>`, `<child>/`, `<child>/index.html` → 404, `no-store`, no cookie, no redirect. Deep (depth ≥ 2) share candidates on real D1 stay inside `/a/<slug>/` and never reach a sibling slug or another page's document. |
| T6 | Page-key and card shares: no fallthrough after a claimed miss; card only for image content; browser flag. |
| T7 | Pinned grants serve their revision after a later publish; follow-active grants follow; `/_revisions/` refuses an old revision without proof, a stale epoch, a revoked grant, and paths the page does not own in that revision. R4 refuses sibling documents/subdocuments even if an ownership edge names them. An owned external fragment or asset resolves through the mounting artefact's current active revision and carries that resource artefact/revision in the `ReadPlan`, while the proof stays bound to the owner page revision; absent or stale mounts deny. A local pinned resource never falls forward to a newer local revision. A resource held locally by the pinned revision is served from it even when another artefact now mounts the same path. An external resource is read only through its edge's provider; a remount by another artefact, an absent mount or a stale mount → `not_found`. A revision of the artefact that does not contain the page → `not_found`, for both the R1 pinned key grant and R4. A token taken from a real `decideRead` allow reads its revision under `/_revisions/`. Each of the following gives no proof: an altered byte; an unknown `kid`; another instance, page or revision; an expired `x`; a stale policy epoch; a revoked or rotated grant; a visibility change; a well-formed token whose MAC Catalogue did not produce. A fabricated `ReadPlan` cannot obtain a token (no API). A token with basis `team`, presented by an anonymous request or with an expired read identity → `not_found`. With a valid token, revocation and epoch changes still deny exactly as without one. `resolveRead` forwards `ReadDeps.pinnedProof` unparsed; no other request credential is treated as a token. |
| T8 | Guard: every verdict reachable; a read-audience identity of a principal holding a publisher role obtains no `ManageActor` and so no mutation; page-scoped publisher cannot create pages or touch other pages; installation publisher can; role revoked or principal disabled between prepare and execute → refused; stale epoch → `conflict` with no effect row and no state change; last admin protected; D1 message format pinned. Structural refusals with no D1 call: empty guard list, two role or principal guards in one batch (two administrators removed together), two guards on one page or one principal. Two administrators removing each other in concurrent separate batches leave at least one active administrator (the second is refused with the first failing verdict in §8.1 priority: `unauthenticated` when the first batch disabled its actor, `conflict` when the first batch moved its actor's authority epoch, `forbidden` if its actor no longer holds an admin role at a matching epoch, otherwise `last_admin`). Multi-page publication guards on distinct pages pass. Pinned `share` and `rotate_share` with a missing or foreign-artefact revision fail as `invalid_state` in the same guarded transaction, leaving page, grant and audit state unchanged. `restore_page`: page-scoped publisher, even on its own page → `forbidden`; installation publisher and administrator pass; live page → `conflict`; unknown page or page of another artefact → `not_found`; revision of another artefact or not containing the page → `not_found`; path mounted by another artefact → `conflict`; stale content version → `conflict`; `mutation_events.action` accepts `restore_page`. An unknown action → `forbidden`. A revision claiming a path under another artefact's `/a/<slug>/` → `conflict`. Ownership admission:<br>- a page-scoped publisher adding or retargeting a cross-artefact edge → `forbidden`, with nothing written;<br>- the same publisher keeping an identical edge of the page's current active revision → `preserved`;<br>- an administrator or installation publisher → `global`; a same-artefact edge → `local`;<br>- an edge whose owner page belongs to another artefact than the revision → `forbidden`;<br>- a new page and its edges in one commit (`create_page`, claim and `revision_pages` in effects, admissions, activation in `finalEffects`) → admitted;<br>- activation placed before the admissions → a preserved edge is refused (fail closed).<br>Structural, `invalid_state` with no D1 call: an edge without a `stage`, `create_page` or `publish` guard on its owner page bound to the same revision, including a publisher of page A guarding A while sending an edge for page B. `executeGuarded` with a handle not minted by `authenticateManage` → `unauthenticated`, with no D1 call. |
| T9 | Commands: every transition of §9; keys absent from every table and event; HMAC verification for minted and imported exact keys; reveal with and without seal key; sealed copy erased on revoke; at most one active grant per page. Self-registration: a new manage identity gets a principal with no role; an existing or disabled principal is returned unchanged; instance mismatch → no row and `instance_mismatch` from `A0`; a read-surface identity or an empty `sub` → `null` with no D1 call. `readPagePolicy` refuses an unminted, expired or other-instance handle, inactive actor, stale actor epoch and out-of-scope publisher before revealing whether the page exists. Restore (§9.4) on real D1: a page dropped by a later revision and a fully unpublished artefact both return under their original page IDs, `private`, policy epoch + 1, with no active grant; former grants stay revoked with their reason, and the former key, cookie and pinned proof are refused by `decideRead`; subtree and tree routes are re-derived; a route claimed meanwhile → `conflict` with no state change; a tree route key under `a/` is refused by the schema. `authenticateManage`: a read-audience token, an empty `sub` or an invalid JWT → `null`, with no D1 call. Commands and `readPagePolicy` refuse an expired handle, a handle of another instance, and a structurally identical unminted object as `unauthenticated`, with no D1 call. |
| T10 | Aliases: exact and prefix; a team identity gets the redirect while the target is live; anonymous and share-cookie viewers get the unaliased outcome, never a redirect (404 `Not found`, `no-store`, no cookie for unclaimed paths, OS-4); tombstoned target. An alias with no target page redirects a team identity and never an anonymous or share-cookie viewer. `setAlias` refuses before any D1 call, as `invalid_state`: an unknown `op` or `kind`; a key or target such as `//evil.com`, `/\evil.com` or `/%5cevil.com`; a tab or other control character; `?` or `#`. The migration CHECK refuses the same rows written directly. `remove` with a primary-route kind is refused and never deletes a page route. |
| T11 | Catalogue: anonymous lists public only; team lists all with visibility; no key or principal data. |
| T12 | Config: every validation rule, seal key bound to read → error, no host fallback; both parsers reject a manage host equal to a read host or alias, and overlapping read/manage audiences, even when the dangerous field is not exposed by their typed result. An unknown field in `FORGE_INSTANCE` is an error. The manage parser requires and exposes `shellPaths`. |
| T13 | Identity: algorithm, signature, `exp`/`nbf` skew, issuer with and without slash, audience per surface, manage requires `sub`, JWKS failure → null, header before cookie. The returned identity is frozen and registered. `isVerifiedIdentity` is false for a structurally identical object, which `decideRead` treats as no team identity. |
| T14 | Hosts and methods: unknown host 403, non-GET/HEAD 405, internal paths 404, shell and login behaviour for both login modes, `safeNext` attack vectors from both legacies. Alias-host login uses the validated alias for both login path and return URL. Tests use real `Request` / `URL` objects: when those normalize dot-segment spellings away, assert normalized confinement rather than an impossible raw-spelling denial. A fabricated Request or overridden `url` is not ingress evidence. |
| T15 | Canonical forms: subtree slug-root forms from OS-3 now, including `/a/<slug>/index` → 308 `/a/<slug>/` and `no-store` without `Set-Cookie`; nested subtree forms per the Pages rule (§11.3 †); tree forms under the OR-1 evidence amendment, as source-derived vectors on real D1: `.html` and extensionless forms; explicit index, `index` and directory forms; the distinct `x/y/index.html` and `d.html` identities with no fallback. Each is asserted for public, private, shared and revoked-grant pages, with canonical redirects only after authorization. The missing-path counterexample is a separate vector: with no route, the `.html`, extensionless and trailing-slash forms give anonymous → login and team → `not_found`. The legacy 404 HTML for a public ref without bytes is recorded as the open F05/F10/F13 gap, not asserted; one-level shared child forms from OS-2 now; deep and asset share forms by real HTTP before F14 (†). |

Header and body bytes (`cache-control`, `content-type`, `Set-Cookie`, the `Not found` body) are emitted by F05 (§11.5). Where T5, T10 and T15 cite observed headers, F03 tests assert the read outcome they derive from: outcome kind and status, `Location`, `ReadPlan.cache = "no-store"` for allowed reads, and no redirect or cookie-emission decision in the outcome. F05 re-asserts the observed headers over real HTTP.

## 15. Duties of later lots

| Lot | Takes from F03 | Owns |
|---|---|---|
| F04 Publication + Revision Store | `authenticateManage`; `executeGuarded` with its `ownership` and `finalEffects` arguments (`stage`, `create_page`, `publish`, `restore_page`, `unpublish` guards); `claimPageStatements`, `retirePageStatements`, `restorePageStatements`; `validateRevisionPaths` | migration `0002_*` (sessions, uploads, idempotency receipts, publication assertions), R2 adapter (create-once, checksum, instance-prefixed keys), manifest validation (paths, kinds, ownership, reserved namespaces), seal, set-based commit (§9), restore by the §9.4 composition (no grant, visibility or role reactivation), retention and GC that keeps pinned revisions, manage-Worker publication endpoints |
| F05 Delivery + read Worker | `resolveRead`, `RouteOutcome`, `ReadPlan` (with its opaque `pinnedProof`), `listCatalogue` | read Worker entry and wrangler configuration, serving through the Store, emitting the redirect and login outcomes F03 computes (no canonicalization or policy in Delivery), share-cookie emission, transport of the opaque pinned-read token and `/_revisions/` rewriting, shell bytes, headers, Range/HEAD/304 after decision, `/api/catalogue` and web catalogue, management link replacing the share bar, removal of legacy mutation endpoints from the read origin, real-HTTP re-assertion of the §11.3 tree expectations (source-derived under OR-1), and an explicit answer, resolved or accepted, for the legacy 404 HTML given to a public ref without bytes (§13 OR-1), never a silent normalization |
| F06 Auth spike | `VerifiedIdentity`, `authenticateManage` | Managed OAuth mode, manage audiences, `sub` stability measurement, management-origin naming (G2) |
| F07 Remote MCP | `authenticateManage`, policy commands, `readPagePolicy`, F04 publication interface | MCP tools as thin adapters, no authorization of its own |
| F08 stdio | — (calls F07/F04 over the network) | local client; no business logic |
| F09 OG and cards | `share_unfurl`, `share_card` outcomes, card candidates | crawler HTML, card serving, Shlink links |
| F10 Import | `claimPageStatements`, `importShare`, `setAlias`, `executeGuarded` ownership admission, `validateRevisionPaths`, schema checks | pages, routes, aliases from `site/_redirects`, revisions from the corpus, exact keys for pages whose legacy visibility is `shared` (a key without `vis:shared` is reported, not imported), visibility unknown → private with report, explicit fragment/asset typing and ownership (G1b), reserved-path collisions reported, public or shared visibility records without bytes reported (OR-1 counterexample) rather than dropped or turned into pages, historical tree URL and access fidelity acceptance before F13 |
| F11 Release operations | migration, config schema, error codes | per-instance Worker configurations, secrets (verifier keys, seal key), `instance_meta` and first-admin bootstrap, staging confirmation of the guard message format, backups including the verifier key, alias-host edge rule |

## 16. Provenance and licenses

- This repository: MIT, "Copyright (c) 2026 Silex" (`LICENSE`).
- `Roxabi/roxabi-forge`: MIT, "Copyright (c) 2026 Roxabi". Ported logic: tree page identity (`treePageId`), keyed tail and browser detection (`functions/_lib/share-unfurl.ts`), card candidates (`pagesForCard`, `cardTargets`), canonical tree URL (`artefactPath` in `functions/_lib/assets.ts`), share-cookie format and parsing, the `..` rule of `safeNext`, fragment and asset access rules (re-expressed as SQL), and the behaviours its tests assert.
- MIT requires the notice in copies of substantial portions: S3 adds `Copyright (c) 2026 Roxabi` to `LICENSE` in the F03 PR, and each ported file and test starts with a provenance comment naming the source path and revision `9c7dda4fd6427dde7da5f474a4519fffefe3ba6a`.

## 17. Owner decisions, declared changes and residual risks

Open owner decisions (none blocks F03 code):

| # | Decision | Trade-off | Needed by |
|---|---|---|---|
| D-1 | Default mode for newly minted share grants | `follow_active` keeps legacy behaviour: recipients see each republication, and a later publish can expose content the sharer never reviewed for that audience. `pinned` shows exactly what was shared: a republish needs a re-share or explicit re-pin, and existing short links keep the old revision. Both are implemented; commands take the mode explicitly. Recommendation: `follow_active` default for parity, `pinned` offered explicitly. | F05/F07 user interfaces |
| D-2 | Initial administrators and publishers per instance (G4) | Who may publish, share and assign roles after cutover. | F11 bootstrap, F13/F14 cutover |

Declared behaviour changes, for the F14 go/no-go list (each follows from the accepted plan or tightens security):

1. Team readers can no longer change visibility or shares, nor see share URLs; that moves to publishers and administrators on the management origin.
2. The ops share secret (`X-Forge-Share-Secret`) is not ported.
3. No request-host fallback for the canonical host; unknown hosts get 403.
4. Still-observable malformed encodings, separators, dot segments and empty segments are refused on every path. Where the URL parser has already erased the spelling, authorization confines the normalized effective path; F03 claims no raw-ingress rejection proof.
5. `safeNext` applies the union of both legacy rules; R keeps the query string in `next`.
6. The injected share bar disappears; F05 adds a management link.
7. Asset access by file-name heuristic (R `pageReferences`) is replaced by declared ownership.
8. Policy changes require the expected policy epoch: concurrent edits get `conflict` instead of last-write-wins.
9. Share keys whose page was not `shared` are not imported, so re-sharing such a page mints a new key.
10. `x-forge-acl: vis-v4` is not emitted as proof of the new model; probes change with F05/F11.

Residual risks:

- D1 error text in production may differ from local workerd; mitigated by pinning tests and the F11 staging check.
- Access `sub` stability for Managed OAuth is unknown until F06.
- The Vitest major upgrade can affect legacy tests; S1 keeps them green or reports the exact failure.
- Resources owned across artefacts follow the providing artefact's active revision (ADR 0002 expected debt).
- The read Worker holds the share verifier keys and a read-write D1 binding (§4). Its compromise could create share verifiers or pinned-read tokens, or write the catalogue. This is accepted as ADR 0002 expected debt; no third Worker or read-only binding is assumed.

## 18. Sources

- Cloudflare D1 Worker API, `batch()` as one SQL transaction: <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- Cloudflare D1 read replication and Sessions API: <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- Cloudflare D1 migrations: <https://developers.cloudflare.com/d1/reference/migrations/>
- Cloudflare D1 foreign keys (enforced by default): <https://developers.cloudflare.com/d1/sql-api/foreign-keys/>
- Cloudflare Pages route matching: <https://developers.cloudflare.com/pages/configuration/serving-pages/>
- Workers Vitest integration configuration (`cloudflareTest`, `readD1Migrations`, `applyD1Migrations`): <https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/>
- Cloudflare Access JWT validation: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json>
- Cloudflare Access application token claims: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token>
- SQLite `CREATE TABLE` constraints and upsert: <https://www.sqlite.org/lang_createtable.html>, <https://www.sqlite.org/lang_upsert.html>
- npm registry metadata read 2026-11-12: `@cloudflare/vitest-plugin@1.8.1` (peer `vitest ^4.1.0 || ^5.0.0`); `@cloudflare/vitest-pool-workers@0.23.0` (peer `vitest ^4.1.0`).
