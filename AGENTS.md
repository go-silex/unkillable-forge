# silex-forge — agent context

## Mission

**forge.gosilex.com** = team HTML artifact host (decks, talks, guides).

| Host | Job |
|---|---|
| `forge.gosilex.com` | Internal artifacts + keyed share links |
| `demo.gosilex.com` | Client demos (funnel) — other repo |
| `share.gosilex.com` | Product ACL target (silex-share) — not this runtime |
| Vercel | **Forbidden** for this flow |

## Access (why private nav used to see everything)

**Before 2026-07-17**: Access was **not** wired → the site was public.

**Now**:

| Zone | Behavior |
|---|---|
| `/` + `/api/catalogue` | Public shell; list = Worker (public vs all if JWT) |
| `/a/<slug>/*` | Worker visibility (private/shared/public) · HTML **and** og.jpg |
| `/s/*` | Bypass + KV key |
| `/login` | Access Allow team (JWT cookie) |

Bypass host `/` and `/a` **only AFTER** Functions deploy (`x-forge-acl: vis-v4`). Before that: Access Allow on the host. Reverse order = leak. `forge-provision.sh` enforces it — its Bypass stage is unreachable until it has seen that header on the live host; there is no override.

## Visibility (model v4)

Content URL: `/a/<slug>/`. Catalogue `GET /` = shell; **list = `GET /api/catalogue`** (Worker).

| KV `vis:<slug>` | Anon catalogue | Access catalogue | Open |
|---|---|---|---|
| **private** (default) | no | yes | JWT / `/login` |
| **shared** | no | yes | `/s/<slug>/<key>/` anon; `/a/` if JWT |
| **public** | yes | yes | `/a/<slug>/` without login (HTML **and** `og.jpg`) |

Fail-closed: no `vis:` = private. `manifest.json` is **not** served to clients.

Trust boundary: publishers are trusted team members. Artifact HTML can execute JavaScript on the Forge origin; prefer self-contained output and never include untrusted third-party scripts.

### Access Zero Trust (after Functions deploy)

1. Functions fail-closed in prod
2. **Then** Bypass `/`, `/a/*`, `/s/*`, `/api/*`; **Allow team** on `/login` (JWT cookie read by Functions)
3. `pages.dev`: 403 on every path (middleware)

### Toolbar UX (team, on `/a/<slug>/`)

**Private** | **Shared** | **Public** → `POST /api/visibility`. Shared mints KV `share:<slug>`.

Optional shortlink via Pages env `SHLINK_API_KEY` + `SHLINK_API_URL` (no defaults; silent fail OK).

## Commands

```bash
S=plugins/silex-forge/scripts/publish.sh

"$S" my-deck --title "…" --type deck # source = hub SSOT
"$S" my-deck ./deck.html --title "…" --type deck
"$S" my-deck ./deck.html --share --title "…" # + share link
"$S" --share my-deck # mint share only
"$S" --unshare my-deck
"$S" --list
"$S" --remove my-deck
"$S" --rebuild-index
```

Deploy: `publish.sh` → `wrangler pages deploy` (token in `~/.config/silex/forge.env`). HTML **not in git**.

## Structure

```
# main = ENGINE only (CF upload)
plugins/silex-forge/ # publish + setup — NOT HTML craft
 forge.config.example.json
 scripts/publish.sh · build-site-from-hub.py · forge-doctor.sh
 scripts/forge-discover.sh · forge-provision.sh · gen-og-images.sh
functions/ # Access middleware, /api/*, /s/*
site/ # skeleton only (404, _headers, …) — NOT artifact HTML
# /s/* runtime # Function + KV

# not in git
# hub $artifacts/<slug>/{index.html,meta.json} = SSOT
# live = wrangler Direct Upload (no payload branch)

# craft (slides / onepager / cheatsheet) = silex-craft@silex-plugins
```

## Machine config (artifacts in silex-hub)

**SSOT HTML** = shared silex-hub vault (path **differs** per person)  
**Deploy** = `publish.sh` → build from hub → `wrangler pages deploy`  
**main** = engine only (no HTML)

| File | Role |
|---|---|
| `~/.config/silex/forge.config.json` | local: `hub_root`, `pages_project`, `public_host`, `vault_markers` — **not git** |
| `~/.config/silex/forge.env` | credentials + Pages plain-var mirror: CF token · account · KV id · `CF_ACCESS_*` · `PUBLIC_HOST` · `SHLINK_API_URL` (chmod 600, dir 700) — **not git** |
| `.env.example` | schema reference for `forge.env` — **never `cp` it onto a real file** |
| plugin `forge.config.example.json` | defaults + fallback if no local config |

Config keys `pages_project` / `public_host` = SSOT in `forge.config.json`; the `PUBLIC_HOST` line in `forge.env` is only the value `publish.sh` injects into the deployed `wrangler.toml`. `.env.example` ships no host value.

### Set up a machine

```bash
wrangler login                                          # OAuth scopes: pages (write), workers_kv (write)
plugins/silex-forge/scripts/forge-discover.sh --write   # attach to an existing forge
plugins/silex-forge/scripts/forge-provision.sh          # OR stand one up on an empty account (interactive only)
plugins/silex-forge/scripts/forge-doctor.sh
plugins/silex-forge/scripts/publish.sh --rebuild-index  # hub → wrangler Pages
```

`--write` merges the discovered keys into `forge.env` (prints **key names only**) and persists the confirmed `pages_project` into an **existing** `forge.config.json` — it never creates that file. Never discoverable: `CLOUDFLARE_API_TOKEN` (API token permissions: Pages Edit · Workers KV Storage Edit · Account Settings Read — not the OAuth scopes above) and `hub_root` (local vault path). Both come from the operator via **`/forge-setup`**.

| `forge-discover.sh` exit | Meaning | Next |
|---|---|---|
| `0` | forge found (missing project keys are listed with a follow-up command — still `0`) | `--write`, then the token |
| `1` | wrangler / npx missing, or not logged in | `wrangler login` |
| `2` | named project absent | other names listed → `--project NAME` · empty account → `forge-provision.sh` · list unparsed → **never provision** |

Project-name defaults are two, on purpose: `forge-discover.sh` → `silex-forge` (the Silex forge), `forge-provision.sh` prompt → `[forge]` (never brand a client's project). `forge.config.json`'s `pages_project` overrides both.

| `forge-doctor.sh` exit | Meaning | Next |
|---|---|---|
| `0` | ready (`--online`: live CF checks pass too) | publish |
| `1` | hub/config KO (or missing `lib/` / `python3`) | operator runs **`/forge-setup`** |
| `2` | hub OK, **deploy blocked** (token · account · KV id · Access vars · `forge.env` perms) | run the command doctor names per blocker |

`--json` (payload) and `--quiet` (one stderr line on any non-zero exit) follow the same codes. A missing token is exit `2`, not a hub problem — and never a silent `0`.

`publish.sh` refuses to deploy while doctor reports `ok: false`: it dies naming `/forge-setup` instead of falling back to the example config. `--share <slug>` verifies the hub artifact exists before any clone or deploy.

## Plugin in this repo

| Plugin | Contents |
|---|---|
| **`silex-forge`** | `forge-publish` · `forge-setup` — **Cloudflare upload only** |

Craft HTML Halo / onepager / cheatsheet → **`silex-craft@silex-plugins`**.  
Generic slide engine + diagrams → external plugins (see **forge-setup**).  
**Rocky**: `rocky@rocky` (`go-silex/rocky`) — outside this repo.

Harness-specific plugin install and validation: README → Install the plugin.

Related plugins (Claude):

```
/plugin marketplace add go-silex/silex-plugins
/plugin install silex-craft@silex-plugins

/plugin marketplace add https://github.com/zarazhangrui/frontend-slides
/plugin install frontend-slides@frontend-slides

/plugin marketplace add https://github.com/cathrynlavery/diagram-design
/plugin install diagram-design@diagram-design

npx skills add alchaincyf/huashu-design

/plugin marketplace add go-silex/rocky
/plugin install rocky@rocky
```

### `silex-plugins`

| Plugin | Why |
|---|---|
| `silex-ops` | Vault, session, HPFO, onboarding |
| `silex-delivery` | ERP, digests, brain-factory, client cases |
| `silex-craft` | `silex-slides` · `silex-onepager` · `silex-cheatsheet` |

## Docs

- `docs/cloudflare-access.md` — Access + Bypass `/s` — **Silex team-prod instance**
- `docs/cloudflare-pages.md` — Pages deploy + env vars — **Silex team-prod instance**
- `docs/share-model.md` — share / key / shortlink
- `docs/artifacts-config.md` — hub SSOT + local forge config + `vault_markers` (client-owned account)
- `docs/public-release.md` — going public + history purge

A forge on someone else's Cloudflare account: `forge-provision.sh` + `"vault_markers": []` — see `docs/artifacts-config.md`, not the two Silex-instance docs above.

## OG thumbnails (landing)

```bash
# pure sh: Chrome headless + ffmpeg (no Python)
plugins/silex-forge/scripts/gen-og-images.sh
plugins/silex-forge/scripts/gen-og-images.sh --slug my-slug --force --quality 4
```

Deps: `google-chrome`|`chromium`, `ffmpeg`, `jq`.  
Writes `site/a/<slug>/og.jpg` (1200×630). Wired in `publish.sh` + `--rebuild-index`.

## Agent rules

1. Never deploy forge on Vercel
2. Never put secrets in `site/`
3. Never list share keys in the catalogue
4. Publish = hub SSOT + `wrangler pages deploy`; CF token = `~/.config/silex/forge.env` — never in git / GH
5. **main** does not hold HTML (`site/a`, `registry/*.json`) — engine only
6. After a large publish: verify Access (302 without cookie) and share (200 without cookie on `/s/.../key/`)
7. **pages.dev** under Access (+ middleware 403 on every path) — never use it as an alternate share origin
8. Share secrets = **KV only** — never `share_key` in meta/registry/HTML
9. Missing forge config → tell the operator to run `/forge-setup` (do not invent hub_root; do not auto-invoke forge-setup)
10. Artifacts → hub `$artifacts_dir/<slug>/`; live CF ← Direct Upload (not git)
11. No Cloudflare account / Access AUD / KV namespace IDs in git — `.env.example` placeholders only
