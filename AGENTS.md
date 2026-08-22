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

Bypass host `/` and `/a` **only AFTER** Functions deploy (`x-forge-acl: vis-v4`). Before that: Access Allow on the host. Reverse order = leak.

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

"$S" my-deck ./deck.html --title "…" --type deck
"$S" my-deck ./deck.html --share --title "…" # + share link
"$S" --share my-deck # mint share only
"$S" --unshare my-deck
"$S" --list
"$S" --remove my-deck
```

Deploy: `publish.sh` → `wrangler pages deploy` (token in `~/.config/silex/forge.env`). HTML **not in git**.

## Structure

```
# main = ENGINE only (CF upload)
plugins/silex-forge/ # publish + setup — NOT HTML craft
 forge.config.example.json
 hooks/ # SessionStart → doctor
 scripts/publish.sh · build-site-from-hub.py · forge-doctor.sh
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
| `~/.config/silex/forge.config.json` | local (hub_root, account/kv ids) — **not git** |
| `~/.config/silex/forge.env` | Pages token + account + KV id (chmod 600) — **not git** |
| `.env.example` | placeholders for forge.env |
| plugin `forge.config.example.json` | defaults + fallback if no local config |

```bash
plugins/silex-forge/scripts/forge-doctor.sh
plugins/silex-forge/scripts/publish.sh --rebuild-index # hub → wrangler Pages
# interactive setup → skill forge-setup
```

Loader: local → example. Hook SessionStart: config KO → **forge-setup**.

## Plugin in this repo

| Plugin | Contents |
|---|---|
| **`silex-forge`** | `forge-publish` · `forge-setup` — **Cloudflare upload only** |

Craft HTML Halo / onepager / cheatsheet → **`silex-craft@silex-plugins`**.  
Generic slide engine + diagrams → external plugins (see **forge-setup**).  
**Rocky**: `rocky@rocky` (`go-silex/rocky`) — outside this repo.

Install (user scope):

```
/plugin marketplace add go-silex/silex-forge
/plugin install silex-forge@silex-forge

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

- `docs/cloudflare-access.md` — Access + Bypass `/s`
- `docs/cloudflare-pages.md` — Pages deploy + env vars
- `docs/share-model.md` — share / key / shortlink
- `docs/artifacts-config.md` — hub SSOT + local forge config

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
9. Missing forge config → **forge-setup** (do not invent hub_root)
10. Artifacts → hub `$artifacts_dir/<slug>/`; live CF ← Direct Upload (not git)
11. No Cloudflare account / Access AUD / KV namespace IDs in git — `.env.example` placeholders only
