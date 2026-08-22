# Changelog

All notable changes to the **silex-forge engine and plugin** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/) for the Claude plugin (`plugin.json` / `marketplace.json`).

**Out of scope for this file:** team HTML artifacts (hub + live deploy). Those are not versioned in git.

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

[1.7.1]: https://github.com/go-silex/silex-forge/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/go-silex/silex-forge/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/go-silex/silex-forge/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/go-silex/silex-forge/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/go-silex/silex-forge/releases/tag/v1.0.0
