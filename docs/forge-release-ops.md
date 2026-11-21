# Forge engine release and deploy ops (F11)

Supersedes the packaging prose in [forge-manual-ops.md](forge-manual-ops.md). Engine code is released only from CI-qualified artifacts. Content publishing is unrelated and never deploys Workers.

## Roles and credentials

| Role | Holds | Must not hold |
|---|---|---|
| Publisher (MCP client) | OAuth / Access identity for manage MCP | Cloudflare API token, account admin, Wrangler deploy rights |
| Operator | Per-account deploy token in a **private** instance directory (`deploy.env`), private Wrangler JSON configs | Plugin marketplace credentials; no need to publish content |
| CI (`engine-release` job) | GitHub token + OIDC for attestations | Cloudflare credentials of any kind |

Private instance directory (outside Git), one per account/environment:

```
instance/
  instance.json    # {"readVariant":"generic"|"unkillable"} — required; picks which read Worker entry to deploy
  manage.json      # Wrangler JSON: account_id, name, d1 database_id, r2 bucket_name, routes, vars — NO main, NO build
  read.json        # same; keep Data/Text rules for native siblings when using unkillable
  deploy.env       # CLOUDFLARE_API_TOKEN=… (mode 0600); loaded in a subshell, never echoed
  deploys.jsonl    # append-only ledger (bindings identities, schemaFloor, Worker version IDs, …)
```

`readVariant: generic` deploys the EMPTY-shell `readWorker` (Roxabi). `unkillable` deploys `unkillableReadWorker` with Unkillable shell assets. Mixing them against the wrong `shellPaths` fails `validateShellAssets` at runtime.

## Engine versioning

- Source of truth: repo-root `engine.json` (`version`, `rollbackCompatibleFrom`).
- Semantics: a deployed release **R** may be replaced by an older release **O** only if `O.version >=` the ledger **`schemaFloor`** (D1-compatible floor). Code-only rollback never lowers `schemaFloor`.
- Migrations are expand-only while older code must keep working. A contract step that drops columns/tables or breaks old readers requires bumping `rollbackCompatibleFrom`.
- Notes: `docs/engine-changelog.md` (`## [X.Y.Z]`). Validated by `scripts/check_plugin_versions.py`.
- Release artifact ships **three** Worker trees: `manage`, `read` (generic), `read-unkillable`.

## Release flow

1. Merge to `main` with the required CI suite green, including the **TruffleHog** check-run from `secret-scan.yml` on the same SHA.
2. Repository variable `FORGE_RELEASES_ENABLED=true` opts in release jobs.
3. Job `engine-release` (after check/test/test-os/test-bash32/test-py39 and publisher jobs; waits for TruffleHog):
   - Skips if tag `engine/v<version>` already points at this commit **with a complete GitHub Release**; resumes incomplete releases on the exact tagged SHA without moving the tag.
   - Fails if that tag exists elsewhere (tags never move).
   - Builds with `scripts/build-engine-release.sh` (locked Wrangler dry-run, both read variants, migrations copy, `release.json`, deterministic tarball via Python).
   - Attests the tarball and `release.json` via `actions/attest-build-provenance`.
   - Creates annotated tag `engine/v<version>` and a GitHub Release with the three artifacts.
4. Client plugin releases separately as `unkillable-forge/vX.Y.Z` (also waits for TruffleHog). Legacy `silex-forge/*` tags are not created anymore.

## Bootstrap a new instance (staging or production)

`instance_meta` is empty after migrations; every manage decision fails closed with `instance_mismatch` until bootstrap. The first administrator is an unguarded operator exception (`origin = 'bootstrap'`, `granted_by` NULL) after that person has authenticated on the management origin so Catalogue can self-register their `principals` row.

1. **Create cloud resources** (operator dashboard or CLI; not in Git): D1, R2, manage + read Workers, Access apps, routes/hostnames, secrets/vars.
2. **Private instance dir** with `instance.json`, `manage.json`, `read.json`, `deploy.env`. Confirm **no** `build` / **no** `main`. D1 bindings must include `binding: "DB"` and **`database_id`**.
3. **Deploy a CI release** (applies expand migrations when needed):
   ```sh
   scripts/forge-deploy.sh verify --tag engine/vX.Y.Z
   scripts/forge-deploy.sh deploy --instance-dir /path/to/instance --tag engine/vX.Y.Z --apply-migrations
   ```
4. **Insert `instance_meta`**:
   ```sh
   scripts/forge-bootstrap.sh instance --instance-dir /path/to/instance --instance-id <id>
   ```
5. **Authenticate a manage request** so the principal row exists: run publisher MCP `connect`, then call any authenticated manage tool (for example `forge_catalogue`) — `connect` alone only stores OAuth tokens; principal insertion happens in `authenticateManage` on a Worker request.
6. **Grant the first installation admin**:
   ```sh
   scripts/forge-bootstrap.sh first-admin --instance-dir /path/to/instance \
     --issuer https://<team>.cloudflareaccess.com --subject <sub>
   ```
7. **Smoke** with `scripts/forge-smoke.mjs`.

## Staging

Use a fully isolated Cloudflare footprint (separate Workers, D1, R2, hostnames) that shares the **same Access policy shape** as production, not the same resources. Follow the bootstrap section on the staging instance dir first, then smoke.

## Production deploy (per instance)

**Staging evidence alone is not production authorization.** Before production cutover obtain **explicit per-instance operator authorization**, confirm F10/G1b gates for that instance when historical import is in scope, and independently confirm account, Worker names, D1/R2 identities, routes, and Access. The convergence plan permits non-production packaging/staging preparation without waiting on historical import; it does **not** authorize production mutation from staging smoke alone.

```sh
scripts/forge-deploy.sh verify --tag engine/vX.Y.Z
scripts/forge-deploy.sh deploy --instance-dir /path/to/instance --tag engine/vX.Y.Z [--apply-migrations]
node scripts/forge-smoke.mjs \
  --mcp-config /path/to/mcp.json --server <name> \
  --root-id <id> --root-dir /path/to/root \
  --read-origin https://read.example \
  --read-cookie-file /path/to/access.cookie \
  [--links /path/to/links.json]
```

Deploy verifies the **same** downloaded bytes (checksums, attestation with signer `go-silex/unkillable-forge/.github/workflows/ci.yml`, `release.json` version + `sourceCommit` = peeled tag SHA, ancestry of default branch, required checks including publisher matrices and TruffleHog). Order: manage then read. Configs with a `build` key or without `account_id` / D1 `database_id` are refused. Ledger pins account + D1 + R2 identities and refuses drift.

## Migrations (expand / contract)

- Wrangler `d1 migrations list --remote` prints **only unapplied** filenames (empty / “No migrations…” when up to date). Lookup failures fail closed.
- That list command **initializes** Wrangler’s migrations table on a fresh remote — not read-only; all dry runs skip it and report that migration state was not checked.
- Unapplied migrations require `--apply-migrations`.
- Expand-only while older readers remain possible. Contract ⇒ bump `rollbackCompatibleFrom`.
- An interrupted or failed migration leaves `.forge-migration-pending` and blocks further mutations. Under explicit operator authorization, reconcile the actual remote D1 migration state and the ledger's compatibility floor before removing the marker; never infer success from the failed command.
- Mutations hold `.forge-deploy.lock`. If it remains after an interruption, confirm no operator process is active before removing the stale lock, then reconcile any pending migration marker.

## Code-only rollback

```sh
scripts/forge-deploy.sh rollback --instance-dir /path/to/instance --to engine/vX.Y.Z
# then smoke again
```

Rollback requires an older release previously deployed to this instance and `target.version >= ledger.schemaFloor`. The ledger keeps `schemaFloor` separate from the running `engineVersion` / `rollbackCompatibleFrom` so a code-only rollback cannot lower the D1 floor. Deploy of an older tag is likewise refused against the floor.

**Do not** (plan §6.4): restore an old D1, re-open with historical rights, re-route blindly to Pages after new writes, or treat DNS alone as data reversibility.

## Evidence to keep privately

- Instance configs, `instance.json`, and `deploy.env` (never commit).
- `deploys.jsonl` (tag, versions, `schemaFloor`, binding identities, Worker version IDs, mode — including `partial-manage` if read fails after manage).
- Smoke JSON reports (no share keys/cookies; fixture ids not keyed paths).
- Per-instance authorization record, Release URL, attestation verification, tag SHA + green checks.
