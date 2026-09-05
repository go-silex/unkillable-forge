# Changelog

All notable changes to the **silex-forge engine and plugin** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/) for the plugin surface (harness manifests / marketplaces / `package.json`).

**Out of scope for this file:** team HTML artifacts (hub + live deploy). Those are not versioned in git.

## [Unreleased]

### Fixed

- Two operator-facing strings in `plugins/silex-forge/scripts/` were still French. `publish.sh` died with `ARTIFACTS_ROOT vide` — untranslated and hintless, where its sibling `die` calls name the fix; it now reads `ARTIFACTS_ROOT is empty` and points at `artifacts_dir` in `forge.config.json` plus `forge-doctor.sh`. The `inject-share-bar.py` module docstring is English on both of its French lines.
- A third French string, `die "usage: --share <slug> ou ..."` in the CLI dispatch, is now `or`. No noun in the language lint's word list could see it, so the list gained the French connectives (`ou`, `avec`, `dans`, `puis`, `selon`, `voir`); `pour` and `sans` stay excluded because `pour` is an English verb and `\bsans\b` matches a CSS `sans-serif` declaration.
- `tests/shell/test_og_persist.sh` leaked one temp directory per run: sourcing `publish.sh` installs its own `trap cleanup EXIT`, which replaced the test's cleanup trap. The trap is re-installed after the source.
- `acquire_publish_lock` treated BusyBox `flock` (present, no `-w` wait timeout) as a lock timeout. Alpine CI (`test-bash32`) is that environment. The function now probes `flock -w 0 /dev/null true` and falls through to the mkdir lockdir when `-w` is missing — the same path macOS already took because it has no `flock` at all.

### Added

- `tests/python/test_lang_boundary.py`. The repo enforced its bash 3.2 floor mechanically (`test_bash32_lint.sh`) but enforced its language convention by human vigilance, which is how `ARTIFACTS_ROOT vide` survived. The boundary is now written down as `AGENTS.md` rule 12 and checked in the Python tier: everything under `plugins/silex-forge/scripts/` is English — comments and docstrings included, no exemption, because a rule with holes is one nobody can apply — against a three-file allowlist whose French is product content, not operator output: `gen-index.py` (site UI), `hub-index.py` (the note written into the hub vault), `share-bar.js` (the team toolbar). The uniform rule earned itself on the first run: a French docstring line with no accents and no `die` prefix had been missed by manual review.
- `publish.sh --dry-run`, accepted on every command and anywhere in argv. The whole chain runs for real — engine materialize, build from the hub, og thumbnails, share-bar injection, `wrangler.toml` patch — but against a sandboxed copy of the hub under `$WORK/hub-root`, and the plan is printed instead of deployed. Nothing reaches the real hub, KV, or a shortlink.

  The single seam is the config, not the environment variable. Three consumers resolve the hub root independently — `publish.sh` via `ARTIFACTS_ROOT`, `build-site-from-hub.py` via `load_config.artifacts_root()`, and `hub-index.py` via `load_config().hub_root` — so `enter_dry_run_sandbox` dumps the resolved config with `hub_root` rewritten and exports `FORGE_CONFIG`. Redirecting the shell variable alone would have covered one consumer in three and left the other two writing to the real vault. The online preflight still runs, and it runs before the sandbox against the real config: a dry run is a gate, not a preview, and exits non-zero on the same missing token or absent Pages project that would stop a deploy.
- `tests/shell/test_publish_resolve_source.sh`, `tests/shell/test_publish_deploy.sh`, `tests/shell/test_publish_dryrun.sh`. `resolve_source` and `deploy_pages` had no tests at all, and `deploy_pages` is the function that decides where production HTML lands. The deploy suite pins the argv (`pages deploy site`, `--branch=main`, `--commit-dirty=true`), the working directory, the exported account, and every fail-closed gate — including that a `FORGE_PAGES_PROJECT` exported after startup cannot redirect the deploy, and that a non-zero wrangler propagates so no share key is minted for a page that never shipped. All three suites are mutation-tested: 19 mutants injected into scratch copies, 19 killed, no survivors.

## [1.13.0] - 2026-09-05

### Changed

- Default `forge_repo` is HTTPS (`git@github.com:go-silex/silex-forge.git` is rewritten); a local engine is opt-in via an existing `forge_repo` path or `FORGE_REPO`, materialized with `git archive HEAD`. `forge-discover.sh` exit 2 lists other Pages projects and points at `--project` / `forge-provision.sh`. `infer_hub_layout` keeps setup from mkdir'ing a parallel Silex artifacts tree beside a client hub. `forge-provision.sh` reuses the chosen Pages name when it already exists and asks `[y/N]` before creating a second project on an account that already has Pages projects.
- `forge-doctor.sh` exit code is three-way instead of binary: `0` ready (`ok` **and** `deploy_ready`; with `--online`, `online_ok` too), `1` hub/config KO or a local prerequisite failure (missing `lib/`, no `python3`), `2` hub OK but deploy blocked. The human report prints one `→` line per `deploy_blockers` entry naming the command that clears it (token, account id, KV id, `CF_ACCESS_*`, `forge.env` permissions), and `--quiet` now emits exactly one stderr line on any non-zero exit instead of failing silently. `--json` and `--quiet` survive a `load_config` crash with one diagnostic instead of a traceback or empty stdout. The `--json` payload shape is unchanged, and `lib/load_config.py --doctor` keeps its 0/1 library semantics — `forge-doctor.sh` is the product surface. `forge-doctor.sh` output is also fully English.
- `forge-discover.sh --write` persists the confirmed `pages_project` into an **existing** `~/.config/silex/forge.config.json`, so `--project NAME` is needed once rather than on every call. It never creates that file: creation belongs to the `forge-setup` skill, and doctor's `no local config` issue has to stay meaningful. `forge.env` no longer stores host or project (those live in `forge.config.json`); it keeps credentials and the Access/Shlink Pages vars (`CF_ACCESS_*`, `SHLINK_*`). Exit `0` with a non-empty `missing[]` now prints a concrete follow-up command per absent key, and `unparsed` no longer suggests `--project` (which cannot fix a parse failure) nor provisioning. Exit codes stay `0` / `1` / `2`.
- `forge-setup` skill: the runtime/shell preamble and doctor branch come first, `hub_root` is bound before it is used, and the account fork (attach with `forge-discover.sh` vs provision with `forge-provision.sh`) precedes the token step. Order is now `0` doctor (`0/1/2`) → `1` hub + bind → `2` write config → `3` artifacts → `4` local doctor → `5` account fork + discover → `6` token → `6b` Shlink → `7` craft plugins → `8` final `--online` doctor and report.
- `.env.example` no longer lists `PUBLIC_HOST` or `FORGE_PAGES_PROJECT`: `forge.config.json` is the single source of truth for the host and the project name, and a stale line in `forge.env` used to decide which Pages project a deploy landed in. The file tells you not to copy it over a discovered `forge.env`.
- Docs describe one setup path instead of three. `AGENTS.md` — the entire setup context a Claude/Codex agent loads through `CLAUDE.md` — now documents `forge-discover.sh` / `forge-provision.sh` and both exit tables, where it previously mentioned only `forge-doctor.sh` and `/forge-setup`. `CONTRIBUTING.md`, `docs/cloudflare-pages.md` and `docs/public-release.md` no longer teach `cp .env.example ~/.config/silex/forge.env`. `docs/cloudflare-pages.md` and `docs/cloudflare-access.md` are labelled as the **Silex team-prod** instance, with the client-owned account documented once in `docs/artifacts-config.md`. OAuth scopes for discovery are separated from API-token permissions for deploy wherever both appear, the two intentional Pages-project defaults (`silex-forge` for discover, `forge` for the wizard) are stated instead of implied, and the `README` / `AGENTS.md` publish cheat sheets are complete and identical.

### Fixed

- The setup surface reported success it had not verified. `doctor()` already returned `deploy_ready` and `deploy_blockers[]`, but only `ok` (hub/config health) drove the exit code, so a machine with no `CLOUDFLARE_API_TOKEN` printed `status : OK`, exited `0`, and looked healthy to `/forge-setup`, to the provisioning wizard's final stage, and to any agent shelling out to it — until the first `publish.sh` died. A machine that cannot deploy now says so with exit `2`.
- `publish.sh` could deploy from a broken config. `require_forge_config` warned and continued whenever `ARTIFACTS_ROOT` was set — which the example-config fallback guarantees — so a partially configured laptop could push to `forge.gosilex.com` with the example host and project. It now dies when `doctor()["ok"]` is false, printing the issues and naming `/forge-setup`; the `ARTIFACTS_ROOT` escape hatch is gone. `--share <slug>` validates that the hub artifact exists before cloning the engine or deploying anything.
- `forge-provision.sh` could create the Access **Bypass** policies without a verified fail-closed deploy: a missing `x-forge-acl` header at stage 10 only triggered a `Continue anyway?` prompt, and answering yes reached stage 11 — publishing every artifact on the account. The escape is deleted. Stage 10 now requires two independent proofs matching what a healthy forge actually emits: `GET /` carries `x-forge-acl: vis-v4` (liveness — `isPublicShell` routes it through `withAcl`), and `GET /a/welcome/` answers `302` → `/login` (fail-closed — an anonymous `/a/<slug>` with no `vis:` key is `loginRedirect()`, which never stamps the header; a `200` there is the leak and a hard fail). An unreadable `wrangler pages project list` aborts instead of offering to create a project, a bare pipe is refused (`yes |` cannot auto-confirm) while `FORGE_PROVISION_NONINTERACTIVE=1` keeps a scripted run against a throwaway account possible, stage 9 forces only `hub_root` / `public_host` / `pages_project` into `forge.config.json` so a re-run no longer clobbers a healthy config or empties `vault_markers`, and a failed `chmod 600` on `forge.env` is fatal rather than best-effort.
- `forge-setup` skill wrote the forge checkout as `hub_root`. `$HUB` was never assigned — step 1 only printed candidates — so `Path("$HUB")` and `echo "$HUB" > hub-root` expanded to the empty string and `Path("").resolve()` returned the current directory. An explicit `HUB="<absolute path confirmed by the operator>"` bind now sits between steps 1 and 2, guarded to exit `1` on an empty or relative value, and step 2 validates it with `vault_ok` before writing.
- `forge.env` silently overrode `forge.config.json` for `PUBLIC_HOST` / `FORGE_PAGES_PROJECT` at deploy time: `source_cf_credentials` re-exported them after the config-derived resolution, so `wrangler pages deploy --project-name` could target a different project from the one `preflight_mutations` and the doctor had just validated. The allowlist no longer includes those keys; provision and discover no longer write them to `forge.env`; `deploy_pages` freezes the config-resolved `PAGES_PROJECT` at startup.
- `publish.sh` on bash 3.2 (macOS stock `/bin/bash`) aborted mid-`cmd_publish` with exit 0 whenever no OG image was produced: `"${img_args[@]}"` on an empty array under `set -u` is a fatal unbound-variable error, the `|| die` never fired, and nothing reached Pages. Both expansions use the 3.2-safe `${arr[@]+"${arr[@]}"}` form, and `test_bash32_lint.sh` rejects a bare `${arr[@]}` under `set -u`.
- `forge-discover.sh --write` replaced a *symlinked* `forge.config.json` with a regular file (`os.replace` swaps the name, not the target), leaving the real config stale. It now resolves the path first. It also no longer writes `public_host` back from Pages `[vars]`, which inverted the direction of truth.
- `forge-provision.sh` cleaned token-bearing temp files from a combined `EXIT HUP INT TERM` trap that did not `exit`. On bash 3.2, INT ran the `rm` and then resumed the wizard. Cleanup is now EXIT-only; INT/TERM/HUP `exit` 130/143/129 so EXIT performs the `rm` once.

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

- `forge-discover.sh` — derives `forge.env` from an existing Cloudflare Pages forge, so onboarding a machine no longer means hand-copying identifiers out of the dashboard. `wrangler pages download config` yields `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `PUBLIC_HOST`, `SHLINK_API_URL` and the KV namespace bound to `SHARES`; `wrangler whoami` yields `CLOUDFLARE_ACCOUNT_ID`. All six match the hand-written file byte for byte, and a `forge.env` built purely from discovery plus a token reports `deploy_ready: true`. Runs under `wrangler login` OAuth alone — no `CLOUDFLARE_API_TOKEN` — verified in a scrubbed environment (`env -i`). `--json` for agents, `--write` merges into `~/.config/silex/forge.env` (chmod 600) printing key names only, never values. Exit `2` when the named project is absent from the account: other Pages names are listed so the operator can retry with `--project NAME`, an empty account points at `forge-provision.sh`, and an unparsable project list refuses to provision.
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

[Unreleased]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.13.0...HEAD
[1.13.0]: https://github.com/go-silex/silex-forge/compare/silex-forge/v1.12.0...silex-forge/v1.13.0
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
