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

From a clone of this repo (the installable package is `plugins/silex-forge/`, not the repo root):

```bash
omp plugin link ./plugins/silex-forge
```

Restart OMP. Link is user-global; files stay in the checkout.

Marketplace install (`omp plugin marketplace add go-silex/silex-forge` then `omp plugin install silex-forge@silex-forge`) is the catalog path. Its skills load only if OMP’s `claude-plugins` provider is enabled. `link` is the native package path. Do not point `omp plugin install github:go-silex/silex-forge` at this repo — that installs the engine root, not the plugin.

Craft HTML separately: **`silex-craft@silex-plugins`**.

### Machine setup

```bash
# first publish if doctor KO → /forge-setup (manual)
plugins/silex-forge/scripts/forge-doctor.sh

cp .env.example ~/.config/silex/forge.env
chmod 600 ~/.config/silex/forge.env
# fill CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, FORGE_SHARES_KV_ID
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
