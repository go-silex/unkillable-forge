# Changelog

All notable changes to the **silex-forge engine and plugin** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/) for the plugin surface (harness manifests / marketplaces / `package.json`).

**Out of scope for this file:** team HTML artifacts (hub + live deploy). Those are not versioned in git.

## [Unreleased]

## [1.12.0] - 2026-09-03

### Changed

- `hub_root` had three divergent resolutions: a five-point search order written as **prose** in the `forge-setup` skill, two of those points implemented in `load_config._bootstrap_hub_root()`, and `forge-provision.sh` simply asking for the path. `hub_root_candidates()` / `resolve_hub_root()` are now the single implementation, returning `(path, origin)` with origins `config`, `env`, `hub-root-file`, `walk-up`, `known-path`. The skill calls `load_config.py --print-hub-candidates` and proposes the best candidate instead of improvising the search.
- `load_config()` deliberately keeps the first three origins only, behind `include_search=False`. Adding `walk-up` and `known-path` to the implicit path would let a machine with no config silently adopt a guessed vault; discovery stays opt-in for setup and provisioning.
- `walk-up` is skipped when `vault_markers` is empty, because `vault_ok(dir, [])` is vacuously true for every directory — the walk would otherwise retain the current directory, or an arbitrary parent, as "the vault".
- `lib/forge_common.sh` — `forge_wrangler`, `forge_die`, `forge_warn`, `forge_info`, `forge_ok`. The `wrangler`/`npx` fallback was written four times and the output helpers were redefined across five scripts. Callers keep their local names as thin aliases, so the visible output of `publish.sh` and `forge-doctor.sh` is byte-identical; `publish.sh` keeps its own `info()` (`▸`, stdout) rather than adopting the library's stderr form.
- `forge-setup` skill: the `FORGE_ROOT` resolution preamble was copied six times, ~138 of 428 lines. One copy now lives in a `Shell setup` section and each block guards with `: "${FORGE_ROOT:?…}"`. 316 lines.

## [1.11.0] - 2026-09-03

### Added

- `forge-provision.sh` — an interactive wizard that stands up a forge on **someone else's** Cloudflare account: Pages project, KV namespace bound as `SHARES`, API token, custom domain, Zero Trust team and the three Access applications. Twelve stages, each resumable; values already saved are offered as defaults on a re-run. Generated from the `wizard` skill template, whose library is kept byte-identical.
- The wizard enforces the ordering hazard documented in `docs/cloudflare-access.md`: the fail-closed Functions are deployed and their `x-forge-acl` header verified **before** any Bypass policy is created. Creating Bypass first would publish every artifact on the account.
- `vault_markers` in `forge.config.json` — `hub_root` was validated against the hard-coded Silex vault layout (`00_COCKPIT`, `01_COMPANY`), so a client's own artifact folder failed `forge-doctor` outright. Absent key keeps the historical behaviour; a list names the directories to require; `[]` checks only that the folder exists. A malformed value is a doctor issue rather than a silent fallback, since either fallback would apply a policy the operator did not choose.
- CI job `test-py39`. macOS ships Python 3.9 (Xcode CLT) while every other job pins 3.12, so a 3.11+ stdlib import (`tomllib`…) or newer syntax would stay green in CI and break on a teammate's laptop. The unit tests now run on the floor interpreter, and `release` is gated on it. `python3` ≥ 3.9 stated in the README dependency table.

### Changed

- CI ShellCheck loops over `plugins/silex-forge/scripts/*.sh` instead of naming three files, so a new script is covered the day it lands. `publish.sh` keeps its `SC1091,SC2086` exclusions; every other script is checked with none.

### Removed

- Unused `ok()` / `info()` helpers in `gen-og-images.sh` — dead since the script was written, and the reason it had never passed ShellCheck.

## [1.10.0] - 2026-09-03

### Added

- `forge-discover.sh` — derives `forge.env` from an existing Cloudflare Pages forge, so onboarding a machine no longer means hand-copying identifiers out of the dashboard. `wrangler pages download config` yields `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `PUBLIC_HOST`, `SHLINK_API_URL` and the KV namespace bound to `SHARES`; `wrangler whoami` yields `CLOUDFLARE_ACCOUNT_ID`. All six match the hand-written file byte for byte, and a `forge.env` built purely from discovery plus a token reports `deploy_ready: true`. Runs under `wrangler login` OAuth alone — no `CLOUDFLARE_API_TOKEN` — verified in a scrubbed environment (`env -i`). `--json` for agents, `--write` merges into `~/.config/silex/forge.env` (chmod 600) printing key names only, never values. Exit `2` when no such project exists on the account: a blank account still needs manual creation.
- README: supported-runtime matrix and dependency table. The POSIX contract (Linux, macOS stock bash 3.2, Windows via WSL — never Git Bash / PowerShell, which lack `python3` on `PATH` and `chmod 600`) existed only in a test-file comment, so a Windows install failed with no stated prerequisite.

### Removed

- `build-site-from-hub.py --slug`. No caller passed it, and it did the opposite of its own help text (`hint only; full hub rebuild always`): it `rmtree`'d `site/<prefix>` and then rebuilt a single artifact, so wiring it into `publish.sh` to "only deploy one slug" would have 404'd every other artifact — a Pages deployment is a complete immutable snapshot.

## [1.9.1] - 2026-09-03

### Fixed

- First publish of a new slug deployed without its OG card. `gen_og_images` writes `og.jpg` under `site/`, then `cmd_publish` called `build_from_hub` again — which rebuilds `site/<prefix>` from the hub SSOT and drops anything the hub does not hold. The card only appeared after someone ran `--rebuild-index` (that path already copied `og.jpg` back). `persist_og_to_hub` now runs between the two, and `--rebuild-index` uses the same helper instead of its own inline loop.

## [1.9.0] - 2026-09-03

### Added

- CI script tests: Linux (`test`) + macOS `/bin/bash` 3.2 (`test-os`, brew bash 5 skipped) + `bash:3.2` container. Windows = WSL (same Linux jobs), not Git Bash / `windows-latest`. Lint `test_bash32_lint.sh` greps every `plugins/silex-forge/scripts/*.sh` for bash 4+ / unguarded GNU (`exec {`, `declare -A`, `mapfile`, flock without probe, `stat -c` without `stat -f`).

### Fixed

- `classify`'s check-run probe only required the `check` job: with no ruleset on this repo, a PR merged with `check` green and `test` red would classify as `pr-merge`, skip both jobs on `main`, and let `release` cut a tag on code `test` had rejected. Both names must now be green.
- `classify` never matched a processed PR merge: `GET /commits/{sha}/pulls` returns the simple pull request representation, which omits `merged` (measured null), so `select(.merged == true and …)` matched nothing and every push was classified `naked` — the suite was re-run on every merge and the § CI landing rule was a no-op. Matching on `state == "closed"` plus `merge_commit_sha` instead; the bounded retry is kept, now guarding a genuine association lag.
- Publish preflight rejected Cloudflare account-owned tokens (`cfat_`): it only called `GET /user/tokens/verify`. Fallback is `GET /accounts/{id}/tokens/verify`.
- `publish.sh` lock used bash 4.1 `{fd}` allocation and Linux `flock`; stock macOS bash 3.2 could not publish. Fixed FD 9 + `mkdir` fallback when `flock` is missing.

## [1.8.2] - 2026-08-31

### Added

- `classify` job — a processed PR merge no longer re-runs the suite (only effects run), with a bounded retry on the commit→PR association
- Automated tag + GitHub Release on merge to `main` when the plugin version is new
- One-SemVer lock across Claude/Grok/OMP/Codex manifests + CHANGELOG (`scripts/check_plugin_versions.py`)
- Hermetic contract test for the release script

### Changed

- Tags now follow Convention A `silex-forge/vX.Y.Z`; the six pre-existing bare `vX.Y.Z` tags are kept as-is and never renamed

## [1.8.1] - 2026-08-30

### Added

- Root `plugin.json` `$schema` Agent Plugins 1.0.0 — OMP marketplace install loads skills with `claude-plugins` off
- OMP plugin-root fallback probes XDG, `~/.omp`, and project `.omp` in `forge-publish` / `forge-setup`

### Changed

- OMP install docs: `omp plugin install silex-forge@silex-forge` is the checkout-free path
- `forge-setup` drops `disable-model-invocation` (not in the Agent Plugins frontmatter allow-list); Codex still uses `agents/openai.yaml`

## [1.8.0] - 2026-08-25

### Added

- Native Grok, OMP, and Codex packaging (catalogs + manifests beside Claude)
- Portable skill root resolution (`SILEX_FORGE_PLUGIN_ROOT` / `GROK_PLUGIN_ROOT` / `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`)

### Changed

- Versioning and install docs treat the surface as a multi-harness plugin, not Claude-only
- `forge-setup` is user-invoked only (`disable-model-invocation`; Codex `agents/openai.yaml`)
- `forge-publish` doctor KO asks the operator to run `/forge-setup` — the model does not invoke it

### Removed

- SessionStart doctor hook (`hooks/hooks.json`, `session-start.sh`, OMP `extensions/session-start.ts`)

## [1.7.3] - 2026-08-22

### Added

- Public artifacts reuse the deterministic Shlink alias `f-<slug>` targeting `/a/<slug>/`
- Copying in Public mode revalidates the alias and reports direct-URL fallback

## [1.7.2] - 2026-08-22

### Fixed

- Shlink aliases are updated when a share key changes instead of failing on an existing `f-<slug>`
- Copying an already-shared artifact revalidates its shortlink after a page reload

## [1.7.1] - 2026-08-22

### Added

- Runtime tests for Access JWT, CSRF, share routing, KV compensation, deploy tooling, and doctor output
- Online doctor checks for Cloudflare token, account, Pages project, and KV namespace

### Changed

- Pages environment variables are read and merged before deploy; remote plain vars are preserved
- CLI mutations run a Cloudflare preflight and use a scoped Wrangler OAuth fallback when needed
- `pages.dev` is denied on every path, including keyed shares
- Trusted-publisher boundary is documented for active same-origin HTML

### Fixed

- Missing `vis:` is strictly private; orphan share keys no longer imply shared visibility
- Share activation/revocation and artifact removal fail closed with compensation and private tombstones
- Cookie-authenticated mutations require JSON and a canonical Origin/Referer
- Share asset paths reject traversal and encoded separators
- Deploy no longer silently wipes `SHLINK_API_URL` or other Pages plain variables
- Doctor JSON/quiet output modes no longer fall through to the human report

## [1.7.0] - 2026-08-22

### Added

- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`
- `.github/` PR template, issue templates, `CODEOWNERS`, CI workflow
- `.env.example` for local Cloudflare credentials (placeholders only)
- `docs/public-release.md` and `scripts/purge-git-history.sh` for safe open-source
- `plugins/silex-forge/scripts/lib/patch_wrangler.py` — safe TOML inject at deploy
- Pages env `PUBLIC_HOST` for configurable share URLs
- Shlink via `SHLINK_API_URL` + `SHLINK_API_KEY` (no hardcoded defaults)

### Changed

- Documentation rewritten in English
- Infrastructure IDs removed from committed files (`wrangler.toml`, config example)
- `publish.sh` reinjects Access / Shlink plain vars on every deploy (prevents Pages wipe)
- `FORGE_SHARE_SECRET` limited to POST/DELETE `/api/share` (not global team auth)
- Share bar uses `location.origin` instead of a hardcoded host
- Doctor `deploy_ready` requires token, account, KV id, Access vars, and `public_host`

### Fixed

- `/s/*` requires `vis:shared` plus valid KV key (fail-closed on revoke)
- CLI `--share` sets `vis:shared` (aligned with Functions)
- `--unshare` fails if KV revoke fails; `--remove` clears `share:` + `vis:`
- Deploy from laptop without `SHLINK_API_URL` preserves existing Pages value when possible

## [1.6.0] - 2026-08

### Added

- Visibility toolbar on `/a/<slug>/` (Private · Shared · Public)
- Worker-gated catalogue (`GET /api/catalogue`) with visibility filter
- Three visibility modes in KV (`private` | `shared` | `public`)
- Share bar injected on hub rebuild (mint via `/api/visibility`)

### Changed

- Engine-only repo: HTML craft moved to `silex-craft@silex-plugins`
- Direct Upload via `wrangler` (no git payload branch)
- Access JWT verification with multiple AUDs (host + `/login` app)

## [1.5.0] - 2026-07

### Added

- Hub SSOT model (`silex-hub` artifacts, machine-local `forge.config.json`)
- `forge-setup` / `forge-doctor` skills and SessionStart hook
- Share-by-key `/s/<slug>/<key>/` with KV (replaces open `/p/` paths)
- Cloudflare Access integration docs and Pages Functions middleware

### Removed

- Committed catalogue HTML and `/p/` public path model
- GitHub Actions deploy of artifact payloads

## [1.0.0] - 2026-07

### Added

- Initial `silex-forge` plugin (`forge-publish`, craft skills later extracted)
- Cloudflare Pages host for team decks and guides
- Plugin marketplace manifest (`.claude-plugin/marketplace.json`)

[Unreleased]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.12.0...HEAD
[1.12.0]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.11.0...silex-forge/v1.12.0
[1.11.0]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.10.0...silex-forge/v1.11.0
[1.10.0]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.9.1...silex-forge/v1.10.0
[1.9.1]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.9.0...silex-forge/v1.9.1
[1.9.0]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.8.2...silex-forge/v1.9.0
[1.8.2]: https://github.com/go-silex/silex-forge/compare/v1.8.1...silex-forge/v1.8.2
[1.8.1]: https://github.com/go-silex/silex-forge/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/go-silex/silex-forge/compare/v1.7.3...v1.8.0
[1.7.3]: https://github.com/go-silex/silex-forge/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/go-silex/silex-forge/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/go-silex/silex-forge/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/go-silex/silex-forge/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/go-silex/silex-forge/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/go-silex/silex-forge/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/go-silex/silex-forge/releases/tag/v1.0.0
