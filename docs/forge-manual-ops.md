# Manual engine packaging and code return

**Preparation only.** No production deployment, historical acceptance, live rollback or F11 delivery is established here. F11/F12 delivery remains gated by F09, functional F10, F08 and the unresolved historical ownership/G1b reconciliation; F09 read is closed. The Claude monthly cap remains in force. The [plan](forge-convergence-plan.md) permits isolated packaging/staging preparation, not bypass of any gate or account authorization. Engine code release is separate from publishing or restoring content: neither operation implies the other.

## Inputs and packaging

- Engine **P**: `f5c8d657a49bbc44105d28c263bb7b9a4dd53b67`, F10 PR #18 draft; its native tests, TSC, independent reviews and CI run `44147968150` were reported successful at that SHA. Historical import is not accepted; migration 0004 has never been applied live.
- Client **Q**: `4db8a1f0d28515c67875ff2bd0d662d730c7156b` F08 staging candidate, not delivered. Reuse its frozen complete `plugins/unkillable-forge` root unchanged — `plugin.json`, harness manifests (`.claude` / `.codex` / `.omp` / `.grok`), skills, package metadata/licence, and the intact `dist/` subtree (`forge.js`, supporting files, `native/manifest.json`, `native/{linux-x64,linux-arm64,darwin-x64,darwin-arm64}/posix.node`). Do not flatten, rebuild or relabel. Native CI exercised that complete package: producer source **S** `5698cc7ee47bd61fc9254fbc514a7568227def5f`, producer run `43956815472`; consumer run `43964424175` attempt 2 succeeded. S is not Q or P. Existing CI packaging is the only producer; no new release mechanism is implied.
- P's lock resolves Wrangler `4.161.0` under `node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler`. These separate candidate identities do not establish a tested combined release. Only a separately reviewed, CI-qualified exact release and its existing artifacts may eventually be selected.

## Offline Worker modules

In P's exact checkout with its locked dependencies already installed, from its root, use a private empty HOME and explicit empty env file. No real credentials or dotenv files are needed. `--dry-run` builds without uploading; these local-only profiles are **never deployable**. `wrangler.read.toml` contains the Data/Text rules for the four native shell files; retain every emitted module, not just the JS entry. Keep output privately; do not put output, credentials or private instance identifiers in Git.

```sh
umask 077
WORK=$(mktemp -d) && chmod 700 "$WORK"
mkdir "$WORK/home" "$WORK/manage" "$WORK/read"
: > "$WORK/empty.env"
W=node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler
env -i PATH="$PATH" HOME="$WORK/home" CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false "$W" deploy --dry-run --config wrangler.manage.toml --env-file "$WORK/empty.env" --outdir "$WORK/manage"
env -i PATH="$PATH" HOME="$WORK/home" CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false "$W" deploy --dry-run --config wrangler.read.toml --env-file "$WORK/empty.env" --outdir "$WORK/read"
find "$WORK/manage" "$WORK/read" -type f -exec sha256sum {} +
```

Use an isolated network-disabled environment for this offline build. The output directory is a build receipt, not by itself an approved deployment or a replacement for the target's configuration. Preserve exact source, tool, full module inventories and hashes alongside existing CI evidence; do not publish private configuration or keys.

## Later authorized operations — not executed here

1. Before any deployment obtain explicit instance-specific authorization and independently confirm the exact account, existing Worker names, existing D1 and R2 bindings, routes, current private Wrangler configs and current key/config references. Private configs are operator-owned, not copies of the checked-in local profiles. No implicit provisioning, build, budget increase, Access/DNS change or publisher admin rights. `workers_dev = false` and `preview_urls = false` do **not** prevent creating a misspelled Worker; negative provisioning settings alone are not an existence check. Stop on any unknown or discrepancy.
2. Only after that gate, transport the already-built and independently reviewed module set. Do not rebuild from sources at deploy time. Use the current approved private Wrangler configs and current key/config refs; never the checked-in local-only profiles and never a replay of an older private profile. Before any deploy invocation, read each approved private config and confirm it has **no** `[build].command` (or equivalent custom build command). Wrangler 4.161.0 runs that custom build from `getEntry`/`runCustomBuild` **before** the bundling choice; `--no-bundle` only skips Wrangler's own rebundling and does **not** by itself promise that no build runs. If a custom build command is present: **STOP**. Do not delete, clear or rewrite the private config to remove it, and do not proceed. Absence of `[build].command` on the local-only checked-in profiles or offline dry-run receipts is not evidence about the private target config. Keep shell path variables explicit:

```sh
W=node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler
MANAGE_ENTRY=/path/to/reviewed/manageWorker.js
READ_ENTRY=/path/to/reviewed/unkillableReadWorker.js
APPROVED_MANAGE_CONFIG=/path/to/current-private-manage.toml
APPROVED_READ_CONFIG=/path/to/current-private-read.toml
"$W" deploy "$MANAGE_ENTRY" --no-bundle --config "$APPROVED_MANAGE_CONFIG" --keep-vars
"$W" deploy "$READ_ENTRY" --no-bundle --config "$APPROVED_READ_CONFIG" --keep-vars
```

These are illustrative commands, **not authorization**. Independently confirm account, existing Worker names, D1/R2 bindings, routes, compatibility settings and current secret/config references first; do not print secrets. Preserve the approved target config, bindings and secrets as-is. `--keep-vars` preserves existing variables; Wrangler deployments do not delete secrets. For read, keep the four reviewed Data/Text sibling modules next to `$READ_ENTRY` and ensure `$APPROVED_READ_CONFIG` still carries the corresponding Data/Text rules (`*.ico`/`*.png`, `*.txt`) that match their imports. No unapproved build, changed module, misspelled Worker name or implicit provisioning may proceed.
3. D1 migration requires a separate, scoped permission and explicit migration approval. Close and drain any incompatible writer before applying the reviewed forward migrations to the confirmed current D1, then verify resulting schema and access before reopening only compatible writers. Never restore an old database, old rights, revoked grants or legacy Pages as a code rollback. In particular **a1 is not established compatible with 0004**: a previous candidate must actually be qualified against current D1/R2 and configuration. Unknown compatibility means remain closed. Do not add a SQL fence merely to manufacture an old-writer test.
4. For an authorized code-only return, select an actually qualified previous compatible module set and deploy it to the same existing Workers against the **same current D1 and R2**, using current key/config references. Do not replace data or credentials. Compare old and new content at the same URLs and confirm revoked access remains denied at the same URLs, with a known authorized positive control. Fail closed on mismatch or unknown. If the real current and previous modules are identical, record that fact; do not relabel a binary, change source cosmetically or call it a different rollback candidate. This runbook is not evidence that this return has been performed.

The existing local Vitest/workerd fixtures provide synthetic D1/R2 and a single configured manage entry, not an already-qualified pair of current/previous production module sets and a switch over the same persistent state. Until such a real pair and its current-release runtime seam are available, a same-state code-return proof remains incomplete; synthetic fixture success alone cannot establish live rollback or historical access fidelity.
