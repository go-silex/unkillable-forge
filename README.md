# silex-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/go-silex/silex-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/go-silex/silex-forge/actions/workflows/ci.yml)

**Team HTML artifact host** — [forge.gosilex.com](https://forge.gosilex.com)

Publish decks, talks, and guides behind Cloudflare Access. Share unlisted links with a path key. Optional shortlinks via Shlink. Engine in git; HTML stays in the shared hub.

| | |
|---|---|
| **Live** | `https://forge.gosilex.com` |
| **Audience** | Silex team (Access) · external = secret `/s/…` links |
| **Not** | `demo.gosilex.com` (client funnel) · Vercel |
| **Deploy** | Cloudflare Pages Direct Upload (`wrangler`) from your laptop |
| **Plugin** | `silex-forge` — `forge-publish` · `forge-setup` |

---

## Why this exists

```
silex-hub / artifacts/<slug>/     SSOT HTML (shared vault, not git)
        │
        ▼  publish.sh
temp tree (functions + site skeleton + hub HTML)
        │
        ▼  wrangler pages deploy
forge.gosilex.com                 live
```

- **git** → plugin, Pages Functions, site skeleton  
- **hub** → HTML source of truth  
- **Pages** → runtime (Access, KV shares, optional Shlink)

---

## Visibility (v4)

| KV `vis:<slug>` | Anonymous catalogue | Team catalogue | Open |
|---|---|---|---|
| **private** (default) | no | yes | JWT / `/login` |
| **shared** | no | yes | `/s/<slug>/<key>/` anon · `/a/` if JWT |
| **public** | yes | yes | `/a/<slug>/` without login |

Fail-closed: missing `vis:` → private. Share keys live in **KV only** — never in HTML, registry, or git.

Toolbar on `/a/<slug>/` (team): **Private** · **Shared** · **Public**.

Publishers are trusted team members. Artifact HTML is active same-origin content: prefer self-contained output and avoid untrusted third-party scripts.

---

## Quick start

### Supported runtime

| OS | Shell | Status |
|---|---|---|
| Linux | any `bash` ≥ 3.2 | supported — CI `test` |
| macOS | stock `/bin/bash` **3.2** | supported — CI `test-os` on `macos-latest` |
| Windows | **WSL** | supported (same as Linux) |
| Windows | Git Bash / PowerShell | **not supported** |

Native Windows fails on requirements the scripts depend on: `python3` on `PATH`
and `chmod 600` on `~/.config/silex/forge.env` (the token file is refused when
it is world-readable). Use WSL.

No bash 4 feature and no GNU-only command is allowed in
`plugins/silex-forge/scripts/` — `tests/shell/test_bash32_lint.sh` enforces it,
and CI runs the suite on `macos-latest` plus a `bash:3.2` container.

| Dependency | Needed for |
|---|---|
| `bash` ≥ 3.2, `python3` ≥ 3.9 (stdlib only), `git`, `curl` | everything |
| `wrangler` **or** `npx` | `wrangler pages deploy` |
| `flock` | optional — a portable `mkdir` lock is used when absent |
| `google-chrome`\|`chromium`, `ffmpeg`, `jq` | OG thumbnails (skipped with a warning if missing) |

### Install the plugin

One plugin tree (`plugins/silex-forge/`). Pick the harness:

#### Claude Code

```text
/plugin marketplace add go-silex/silex-forge
/plugin install silex-forge@silex-forge
```

#### Grok

```bash
grok plugin marketplace add go-silex/silex-forge
grok plugin install silex-forge --trust
```

#### Codex

```bash
codex plugin marketplace add go-silex/silex-forge
codex plugin add silex-forge@silex-forge
```

CLI verb is `plugin add`, not `plugin install`. Start a new thread after install.

#### Oh My Pi

Checkout-free (skills load via Agent Plugins `$schema`, even with `claude-plugins` off):

```bash
omp plugin marketplace add go-silex/silex-forge
omp plugin install silex-forge@silex-forge
```

Then `/reload-plugins` (or restart). Dev on a clone — live symlink:

```bash
omp plugin link ./plugins/silex-forge
```

Link is user-global; files stay in the checkout. Do not `omp plugin install github:go-silex/silex-forge` — that installs the engine root, not the plugin.

Craft HTML separately: **`silex-craft@silex-plugins`**.

### Machine setup

Existing forge on this Cloudflare account — discover, do not retype:

```bash
wrangler login
plugins/silex-forge/scripts/forge-discover.sh --write
# fill CLOUDFLARE_API_TOKEN in ~/.config/silex/forge.env
plugins/silex-forge/scripts/forge-doctor.sh
```

`--write` merges into `~/.config/silex/forge.env` (`chmod 600`) and prints key names only. Discovery is OAuth-only (`wrangler login`) — no API token. Needed scopes: `pages (write)`, `workers_kv (write)`.

Still fill `CLOUDFLARE_API_TOKEN` (deploy is not OAuth-only; `publish.sh` dies without it) and `hub_root` in `forge.config.json` (local vault path; Cloudflare cannot see it). Doctor KO → `/forge-setup`.

| Value | Source | Why |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | discover | logged-in account |
| `FORGE_SHARES_KV_ID` | discover | KV bound as `SHARES` |
| `CF_ACCESS_TEAM_DOMAIN` | discover | Pages env |
| `CF_ACCESS_AUD` | discover | Pages env |
| `PUBLIC_HOST` | discover | Pages env |
| `SHLINK_API_URL` | discover | Pages env |
| `CLOUDFLARE_API_TOKEN` | **manual** | deploy still requires a token |
| `hub_root` | **manual** | per-person vault; not on Cloudflare |

No Pages project on this account → exit `2`. Create Pages + KV + Access by hand, then:

```bash
cp .env.example ~/.config/silex/forge.env
chmod 600 ~/.config/silex/forge.env
# fill remaining keys — see table
```

| File | Role |
|---|---|
| `~/.config/silex/forge.config.json` | `hub_root`, … (local, not git) |
| `~/.config/silex/forge.env` | CF credentials · `chmod 600` |
| `.env.example` | committed placeholders |
| `plugins/…/forge.config.example.json` | defaults / fallback |

### Publish

```bash
S=plugins/silex-forge/scripts/publish.sh

"$S" my-deck --title "My deck" --type deck
"$S" my-deck ./deck.html --title "My deck" --type deck
"$S" --share my-deck
"$S" --rebuild-index
```

Team URL: `https://forge.gosilex.com/a/<slug>/`  
Share URL: `https://forge.gosilex.com/s/<slug>/<key>/`

---

## Shortlinks (Shlink)

Best-effort. Failures are silent — you still get the long `/s/…` URL.

| Path | Needs |
|---|---|
| **UI / Functions** | Pages env: `SHLINK_API_KEY` + `SHLINK_API_URL` (full create URL, **no default**) |
| **CLI** (`publish.sh --share`) | Local `shlink` CLI + `shlink_domain` in forge config |

---

## Security

| Zone | Control |
|---|---|
| `/` + `/a/*` | Access after Functions deploy · Bypass only once Functions are live |
| `/s/*` | Access Bypass + KV key check |
| `/login` | Access Allow team |
| `*.pages.dev` | Access + middleware 403 on every path |
| Repo | Engine only — **no** HTML, **no** share keys, **no** account/AUD/KV IDs, **no** API tokens |

Never put secrets in `site/`. Never list share keys in the catalogue.

---

## Repo layout

```
.env.example                  # forge.env placeholders
plugins/silex-forge/          # multi-harness plugin (publish + setup)
functions/                    # Access middleware, /api/*, /s/*
site/                         # skeleton only — no artifact HTML
docs/                         # Access, Pages, share, hub config
wrangler.toml                 # placeholder KV id (patched at deploy)
```

---

## Docs

| Doc | Topic |
|---|---|
| [docs/cloudflare-access.md](docs/cloudflare-access.md) | Access + Bypass |
| [docs/cloudflare-pages.md](docs/cloudflare-pages.md) | Deploy + Pages env |
| [docs/share-model.md](docs/share-model.md) | Share / key / Shlink |
| [docs/artifacts-config.md](docs/artifacts-config.md) | Hub SSOT |
| [docs/public-release.md](docs/public-release.md) | Going public + history purge |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute (engine only) |
| [CHANGELOG.md](CHANGELOG.md) | Plugin / engine releases |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [SUPPORT.md](SUPPORT.md) | What we support on GitHub |
| [AGENTS.md](AGENTS.md) | Agent rules |

---

## Related plugins

| Plugin | Role |
|---|---|
| `silex-craft@silex-plugins` | Halo slides / onepager / cheatsheet |
| `frontend-slides` | Slide engine used by `silex-slides` |
| `diagram-design` · `huashu-design` | Optional craft |
| `rocky@rocky` | Separate product |

---

## License

[MIT](LICENSE) — engine and plugin. Team HTML artifacts are **not** licensed through this repository (hub / Access).

Before making the repo public, run [docs/public-release.md](docs/public-release.md) (git history purge).
