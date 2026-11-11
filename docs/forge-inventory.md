# Forge inventory

Read-only evidence for one forge instance. It does not publish, reanchor, deploy, or write Cloudflare. It does not import artifact HTML, execute scripts, follow symlinks, or approve a migration.

`plugins/silex-forge/scripts/forge-inventory.py`

## Run

```bash
python3 plugins/silex-forge/scripts/forge-inventory.py \
  --config /path/to/forge.config.json \
  --env /path/to/forge.env \
  --output /path/outside/git/forge-inventory.json
```

| Flag | Required | Effect |
|---|---|---|
| `--config` | yes | JSON object. The example config is not merged in. |
| `--env` | yes | `KEY=value` / `export KEY=value` lines. Never sourced. |
| `--output` | yes | Private JSON. Refused if the path is inside any git worktree, or if it already exists. |
| `--without-history` | no | Skip production deployment history. |
| `--local-only` | no | Enumerate the hub only. No network call. |

Stdout is one summary line: file counts, completeness, and the output path. The corpus is not printed. Exit `0` only when the report has no issue, or the only issue is `local_only`. `complete` is still false for a local-only run. Any other issue exits `1` after the report is written. A bad config, a bad env file, a git output path, or an existing output path exits `1` and writes nothing.

Config and env must both be passed. A missing `pages_project` is not filled from another forge instance. If both sides provide account, namespace, host, or project, they must match. Values are not printed.

## What is recorded

| Block | Meaning |
|---|---|
| `local_selection` | Files under `hub_root` / `artifacts_dir`: relative path, size, SHA-256, symlink diagnostic. |
| `slug_index_html` | Top-level directories whose `index.html` is a regular file or a symlink. |
| `tree_candidates` | Every readable `*.html` / `*.htm` file under the artifacts root. |
| `tree_builder_selected` | Always null. This tool has no tree builder and does not apply exclude rules. |
| `html_flags` | Counts and per-file booleans only. No HTML content. |
| `observed_live` | Canonical Pages deployment, its file-hash map, optional production history, KV keys. |
| `snapshot_record` | The `snapshot:live` KV record, checked against the canonical deployment id. Not live bytes. |
| `issues` | Stable `code` plus a fixed English `detail`. |
| `complete` | True only when `issues` is empty. |

`schema_version` is `1`. `collected_at` is UTC `YYYY-MM-DDTHH:MM:SSZ`.

HTML flags are `existing_base`, `root_relative_fetch`, `location_href`, and `hardcoded_host`. The host flag is false when `public_host` is empty. Matching text is not copied out.

## Live reads

Every production request is GET, origin fixed to `https://api.cloudflare.com`, timeout 60 seconds, redirects not followed. The token is not logged.

| Read | Path |
|---|---|
| Project | `/accounts/{account}/pages/projects/{project}` |
| Canonical files | `.../deployments/{canonical_id}/files` |
| History | `.../deployments?env=production&page=N` until `total_pages` |
| KV keys | `/accounts/{account}/storage/kv/namespaces/{namespace}/keys` |
| KV value | `.../values/{key}` for `vis:`, `share:`, and `snapshot:` keys only |

The file source is `canonical_deployment`, never `latest_deployment`. `deployment_drift` is true when those ids differ or one is missing. It is an observation, not a failure by itself.

Pages file hashes are stored as opaque strings. This tool does not assume SHA-256, does not call wrangler, and does not recompute another hash algorithm. A separate calibration is not a dependency of this command.

If `pages_project` is absent, the tool lists projects and keeps the one whose `domains` entry equals the configured `public_host`. Zero or several matches set `complete` false. The configured name and the resolved name are stored separately.

## What is not stored

Account ids, KV namespace ids, audience ids, tokens, and absolute hub paths are redacted. Share values are never written: only the key name, `present`, byte `length`, and SHA-256. A value of 8 bytes or more is also held in memory only long enough to redact it from issue strings, then discarded.

## Limits

- Symlinks are recorded and not followed. A target outside the artifacts root is `external`. A missing target is `broken`. A loop is `cycle`. An internal target is `internal`.
- External roots and symlink cycles are not walked. Large files are hashed in 1 MiB chunks, not loaded whole.
- Unreadable entries set `readable` false, `complete` false, and the walk continues.
- A missing `hub_root` or `artifacts_dir` is an error. There is no silent default path.
- History and project-list pagination stop on a repeated page, a repeated cursor, or a missing `total_pages`. A repeated page is the same ordered row identity: deployment `id`, or project `name` when the list has no `id`. `complete` is then false.
- A 404 on a listed KV value is absence, not a network failure. Any other non-200 is an issue.
- The report is private machine evidence. It is not a git artifact and not a statement that a previous tree plus the current tree may be migrated.
- The legacy publisher is not imported and not called.
