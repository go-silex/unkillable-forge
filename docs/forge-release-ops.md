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
  manage.json      # Wrangler JSON: account_id, name, bindings, routes, vars — NO main, NO build
  read.json        # same; keep Data/Text rules for native siblings
  deploy.env       # CLOUDFLARE_API_TOKEN=… (mode 0600); loaded in a subshell, never echoed
  deploys.jsonl    # append-only ledger written by forge-deploy
```

## Engine versioning

- Source of truth: repo-root `engine.json` (`version`, `rollbackCompatibleFrom`).
- Semantics: a deployed release **R** may be replaced by an older release **O** only if `O.version >= R.rollbackCompatibleFrom`.
- Migrations are expand-only while older code must keep working. A contract step that drops columns/tables or breaks old readers requires bumping `rollbackCompatibleFrom`.
- Notes: `docs/engine-changelog.md` (`## [X.Y.Z]`). Validated by `scripts/check_plugin_versions.py`.

## Release flow

1. Merge to `main` with the required CI suite green.
2. Repository variable `FORGE_RELEASES_ENABLED=true` opts in release jobs.
3. Job `engine-release` (after check/test/test-os/test-bash32/test-py39 and publisher jobs):
   - Skips if tag `engine/v<version>` already points at this commit or an ancestor.
   - Fails if that tag exists elsewhere (tags never move).
   - Builds with `scripts/build-engine-release.sh` (locked Wrangler dry-run, migrations copy, `release.json`, deterministic `forge-engine-<version>.tar.gz` + `SHA256SUMS`).
   - Attests the tarball and `release.json` via `actions/attest-build-provenance`.
   - Creates annotated tag `engine/v<version>` and a GitHub Release with the three artifacts.
4. Client plugin releases separately as `unkillable-forge/vX.Y.Z` from `plugins/unkillable-forge/plugin.json` (job `release`). Legacy `silex-forge/*` tags are not created anymore.

## Bootstrap a new instance (staging or production)

`instance_meta` is empty after migrations; every manage decision fails closed with `instance_mismatch` until bootstrap. The first administrator is an unguarded operator exception (`origin = 'bootstrap'`, `granted_by` NULL) after that person has signed in once on the management origin (principal self-registration).

1. **Create cloud resources** (operator dashboard or CLI; not in Git): D1 database, R2 bucket, manage + read Workers (or leave names for first deploy), Access applications for read and manage audiences, routes/hostnames, secrets/vars on the private instance configs.
2. **Private instance dir** with `manage.json`, `read.json`, `deploy.env` (see above). Confirm **no** `build` key and **no** `main`.
3. **Deploy a CI release** (applies expand migrations when needed):
   ```sh
   scripts/forge-deploy.sh verify --tag engine/vX.Y.Z
   scripts/forge-deploy.sh deploy --instance-dir /path/to/instance --tag engine/vX.Y.Z --apply-migrations
   ```
4. **Insert `instance_meta`** (contract_version 1; refuse if a different `instance_id` already exists; idempotent for the same id):
   ```sh
   scripts/forge-bootstrap.sh instance --instance-dir /path/to/instance --instance-id <id>
   ```
   `<id>` must match `^[a-z][a-z0-9-]{1,39}$` and the Worker config `instanceId`.
5. **Operator signs in once** on the management origin via the publisher MCP `connect` flow so Catalogue self-registers their `principals` row.
6. **Grant the first installation admin** (only if no active admin grant exists; idempotent if the same principal already holds it):
   ```sh
   scripts/forge-bootstrap.sh first-admin --instance-dir /path/to/instance \
     --issuer https://<team>.cloudflareaccess.com --subject <sub>
   # or, when email_hint is unique on an active principal:
   scripts/forge-bootstrap.sh first-admin --instance-dir /path/to/instance --email admin@example.com
   ```
7. **Smoke** with `scripts/forge-smoke.mjs` (and keep private evidence: ledger, smoke JSON without keys/cookies).

## Staging

Use a fully isolated Cloudflare footprint (separate Workers, D1, R2, hostnames) that shares the **same Access policy shape** as production, not the same resources. Follow the bootstrap section above on the staging instance dir first.

1. `scripts/forge-deploy.sh verify --tag engine/vX.Y.Z`
2. `scripts/forge-deploy.sh deploy --instance-dir <staging-dir> --tag engine/vX.Y.Z [--apply-migrations]`
3. Bootstrap (`instance` → MCP connect → `first-admin`) if the staging D1 is new.
4. `node scripts/forge-smoke.mjs …` against staging read origin + publisher MCP.
5. Only then deploy the **same tag** to each production instance directory (bootstrap production only once).

## Production deploy (per instance)

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

Deploy order is manage then read. Wrangler is `$WRANGLER` or the repo-locked binary under `node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler`. Configs with a `build` key or without `account_id` are refused. Worker `name` must match the previous ledger entry for that role.

## Migrations (expand / contract)

- Unapplied migrations listed in `release.json` require `--apply-migrations`.
- Apply from the release’s `migrations/` copy via a temp config with `migrations_dir`.
- Expand-only while readers/writers on older engine builds remain possible.
- Contract (dropping compatibility) ⇒ bump `rollbackCompatibleFrom` in the same engine release that makes the break.

## Code-only rollback

```sh
scripts/forge-deploy.sh rollback --instance-dir /path/to/instance --to engine/vX.Y.Z
# then smoke again
```

Compatibility rule: if the remote D1 has migrations unknown to the target release, rollback is refused unless the currently deployed release’s `rollbackCompatibleFrom` is `<=` the target version (ledger + current `release.json`).

**Do not** (plan §6.4): restore an old D1, re-open with historical rights, re-route blindly to Pages after new writes, or treat DNS alone as data reversibility. Prefer a previous compatible Worker on the **same current** R2/D1. On a data incident, close access first.

## Evidence to keep privately

- Instance configs and `deploy.env` (never commit).
- `deploys.jsonl` ledger lines (tag, engine version, source SHA, Worker version IDs, timestamp, mode).
- Smoke JSON reports (no share keys/cookies).
- GitHub Release URL, attestation verification output, and the exact tag SHA that was verified as an ancestor of default branch with required checks green.
