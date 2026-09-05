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

Two paths. **Attach** to a forge that already exists (a Silex teammate's machine,
or a second laptop) — or **provision** one on your own Cloudflare account.

#### Attach to an existing forge

```bash
wrangler login
plugins/silex-forge/scripts/forge-discover.sh --write
plugins/silex-forge/scripts/forge-doctor.sh
```

`--write` merges the discovered keys into `~/.config/silex/forge.env` (`chmod 600`,
directory `700`) printing **key names only**, and persists the confirmed
`pages_project` into an **existing** `~/.config/silex/forge.config.json` — so
`--project` is needed at most once. It never creates that config file: the
`/forge-setup` skill owns creation, and until it runs the project name is not
remembered between calls.

Do **not** `cp .env.example ~/.config/silex/forge.env`. The example is a schema
reference (key names + comments); copying it over a discovered file wipes real
values.

Two Pages-project defaults, both deliberate:

| Command | Default project | Why |
|---|---|---|
| `forge-discover.sh` | `silex-forge` | attaches to the Silex team forge — override with `--project NAME` |
| `forge-provision.sh` | `forge` | your own account; the wizard must not brand your project with ours |

`forge-discover.sh` reads `pages_project` from `forge.config.json` first, so once
it is persisted that value wins over both defaults.

Two different Cloudflare credentials — do not mint one from the other's list:

| Credential | Used by | Needs |
|---|---|---|
| `wrangler login` **OAuth** | `forge-discover.sh`, `forge-provision.sh`, `--share` KV fallback | scopes `pages (write)`, `workers_kv (write)` |
| `CLOUDFLARE_API_TOKEN` in `forge.env` | `publish.sh` — every deploy | permissions Account · Cloudflare Pages · **Edit** · Account · Workers KV Storage · **Edit** · Account · Account Settings · **Read** |

Discovery is OAuth-only and never sees a token; deploy is token-only and
`publish.sh` dies without one.

| Value | Source | Why |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | discover | logged-in account |
| `FORGE_SHARES_KV_ID` | discover | KV bound as `SHARES` |
| `CF_ACCESS_TEAM_DOMAIN` | discover | Pages env |
| `CF_ACCESS_AUD` | discover | Pages env |
| `PUBLIC_HOST` | discover | Pages env |
| `SHLINK_API_URL` | discover | Pages env |
| `CLOUDFLARE_API_TOKEN` | **manual** | a secret — deploy still requires a token |
| `hub_root` | **manual** | per-person vault path; Cloudflare cannot see it |

Discover exits `0` even when the project is missing some of those keys; it then
prints a follow-up command per missing key. `forge-doctor.sh` is the
machine-readable "can this laptop deploy?" answer.

#### Discover exit codes

| Exit | Meaning | Next |
|---|---|---|
| `0` | forge found | `--write`, then add the API token |
| `1` | `wrangler`/`npx` missing, or not logged in | `wrangler login`, retry |
| `2` | no Pages project by that name | three branches below |

Exit `2` is not one situation:

| Account state | What discover prints | Do |
|---|---|---|
| **other** Pages projects exist | the list of names | `forge-discover.sh --write --project NAME` |
| **no** Pages project at all | nothing to attach to | `forge-provision.sh` |
| project list **unparsable** | "could not parse `wrangler pages project list` output — not creating a new forge" | **never provision** — run that command yourself; if it prints your projects, relink the plugin (wrangler version mismatch) |

The third branch matters: a forge may already exist on an account whose project
list you cannot read, and a second Pages project would split artifacts across
two origins. Discover refuses to suggest `--project` there (the same unreadable
list would be re-parsed) and the wizard fails closed on the same signal.

#### Provision your own forge

```bash
plugins/silex-forge/scripts/forge-provision.sh
```

An interactive wizard (it aborts on a non-TTY): Pages project, KV namespace, API
token, custom domain, Zero Trust team and the three Access applications. Twelve
stages, resumable — re-run it and already-saved values come back as defaults. It
will not overwrite a healthy `forge.config.json`. If the account already has
other Pages projects, the wizard lists them and asks `[y/N]` before creating a
second one; `N` points at `forge-discover.sh --project NAME`. If it cannot read
the project list, it aborts instead of asking.

It deploys the fail-closed Functions and verifies the live `x-forge-acl: vis-v4`
header **before** the Access Bypass stage — and stops there if the header is
absent. There is no "continue anyway": Bypass first would publish every
artifact. See [cloudflare-access.md](docs/cloudflare-access.md).

A forge outside the Silex vault needs `"vault_markers": []` in
`forge.config.json`; the wizard writes it when the key is absent and never
overwrites an existing value — see
[artifacts-config.md](docs/artifacts-config.md).

#### Doctor exit codes

```bash
plugins/silex-forge/scripts/forge-doctor.sh            # human report
plugins/silex-forge/scripts/forge-doctor.sh --json     # payload for agents
plugins/silex-forge/scripts/forge-doctor.sh --quiet    # one stderr line if not ready
plugins/silex-forge/scripts/forge-doctor.sh --online   # + live Cloudflare checks
```

| Exit | Meaning | Next |
|---|---|---|
| `0` | ready — hub config sound **and** deploy credentials complete | publish |
| `1` | hub / local config KO (`hub_root`, missing keys, no `python3`) | run `/forge-setup` |
| `2` | hub OK, **deploy blocked** | fix each blocker doctor names (token, account id, KV id, Access vars, `forge.env` permissions) |

Exit `2` is the case a token-less laptop used to report as `OK`. Each blocker is
printed with the command that clears it.

| File | Role |
|---|---|
| `~/.config/silex/forge.config.json` | `hub_root`, `pages_project`, `public_host`, `vault_markers` (local, not git) |
| `~/.config/silex/forge.env` | CF credentials + the Pages plain vars injected at deploy · `chmod 600` |
| `.env.example` | committed **schema reference** — placeholders, never copied over a real file |
| `plugins/…/forge.config.example.json` | defaults / fallback |

### Publish

```bash
S=plugins/silex-forge/scripts/publish.sh

"$S" my-deck --title "My deck" --type deck          # source = hub SSOT
"$S" my-deck ./deck.html --title "My deck" --type deck
"$S" my-deck ./deck.html --share --title "My deck"  # publish + mint a share link
"$S" --share my-deck                                # mint a share link only
"$S" --unshare my-deck
"$S" --list
"$S" --remove my-deck
"$S" --rebuild-index
```

`publish.sh` refuses to run while the local config is broken: it prints the
doctor issues and names `/forge-setup` rather than deploying with example
defaults. `--share <slug>` checks the artifact exists in the hub before it
deploys anything.

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
| `/` + `/a/*` | Access after Functions deploy · Bypass only once the live host answers `x-forge-acl: vis-v4` |
| `/s/*` | Access Bypass + KV key check |
| `/login` | Access Allow team |
| `*.pages.dev` | Access + middleware 403 on every path |
| Repo | Engine only — **no** HTML, **no** share keys, **no** account/AUD/KV IDs, **no** API tokens |

Never put secrets in `site/`. Never list share keys in the catalogue.

---

## Repo layout

```
.env.example                  # forge.env schema reference (placeholders only)
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
| [docs/cloudflare-access.md](docs/cloudflare-access.md) | Access + Bypass — **Silex team-prod instance** |
| [docs/cloudflare-pages.md](docs/cloudflare-pages.md) | Deploy + Pages env — **Silex team-prod instance** |
| [docs/share-model.md](docs/share-model.md) | Share / key / Shlink |
| [docs/artifacts-config.md](docs/artifacts-config.md) | Hub SSOT · `vault_markers` · forge on your own account |
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
