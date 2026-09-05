# Cloudflare Access — Silex team-prod instance

**Scope:** the **Silex** production forge (`forge.gosilex.com`, Pages project
`silex-forge`). Configuring your own forge? Do not create these apps by hand and
do not point them at our host — `plugins/silex-forge/scripts/forge-provision.sh`
creates the same three applications on your account, in the safe order, with
your host. Client-owned setup notes live in
[artifacts-config.md](./artifacts-config.md).

## Goal

| Path | Who |
|---|---|
| `/` catalogue shell · `/a/<slug>/` | Team (Access JWT) unless visibility is **public** |
| `/s/<slug>/<key>/` | Anyone with the secret link (Access **Bypass**) |
| `/login` | Access **Allow** team — issues the JWT cookie Functions read |
| `*.pages.dev` | Denied by middleware on every path |

Open `/p/` paths are **gone**. External share = keyed `/s/…` only.

## Apps (Zero Trust)

After Functions are live and the host actually answers `x-forge-acl: vis-v4`:

| App | Domain path | Policy |
|---|---|---|
| **Silex Forge · login** | `forge.gosilex.com/login` | Allow team emails / IdP group |
| **Silex Forge · public surface** | `forge.gosilex.com/`, `/a/*`, `/s/*`, `/api/*` | **Bypass** everyone (Functions enforce visibility) |
| **Silex Forge · pages.dev** | `<project>.pages.dev` | Allow team + middleware 403 on every path |

**Order matters:** deploy fail-closed Functions **first**, verify the header, then flip host Bypass. Bypass before Functions = public leak. `forge-provision.sh` enforces this: its Bypass stage is unreachable until it has observed `x-forge-acl: vis-v4` on the live host — a missing header aborts the wizard, there is no "continue anyway". Configuring by hand, run the check yourself:

```bash
curl -sI "https://<your-host>/a/<any-slug>/" | grep -i x-forge-acl   # must print vis-v4
```

| Origin | Catalogue + `/a` | Share `/s` |
|---|---|---|
| `forge.gosilex.com` | Worker visibility | Function + KV |
| `<project>.pages.dev` | middleware 403 | middleware 403 |

## Setup checklist

Cloudflare account that owns the zone · zone for your public host.

Order: login app (1) → JWT env in place (4) → deploy the Functions
(`publish.sh --rebuild-index`) and confirm `x-forge-acl: vis-v4` on the live
host → Bypass app (2) → `pages.dev` app (3). `publish.sh` injects
`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` from `forge.env` at deploy, so step 4
is really "have those two keys in `forge.env`". `forge-provision.sh` follows the
same dependency order and refuses to reach the Bypass step without the header.

### 1. Self-hosted app (login)

1. [Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → **Add**
2. Self-hosted · path `/login` on the forge host
3. Policy **Allow** → emails ending in your team domain (or IdP group)
4. Session duration as you prefer

### 2. Bypass for Functions-gated paths

**Only after** the header check above returns `x-forge-acl: vis-v4`.

Separate app(s) or paths: `/`, `/a/*`, `/s/*`, `/api/*` → policy **Bypass** → everyone.

### 3. Protect pages.dev

Self-hosted app on `*.pages.dev` for the Pages project → **Allow** team.  
Functions middleware also returns 403 on every path, including `/s/`. Shares are canonical on the custom host only.

### 4. Wire JWT env on Pages

Set on the Pages project (dashboard — **not** in git):

| Var | Type |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | plain (`<team>.cloudflareaccess.com`) |
| `CF_ACCESS_AUD` | plain (comma-separated Access application AUDs) |

Functions fail closed if either is missing.

## Smoke tests

```bash
curl -sI "https://forge.gosilex.com/login"                 # 302 → Access
curl -sI "https://forge.gosilex.com/a/<private-slug>/"      # 302 without cookie
curl -sI "https://forge.gosilex.com/s/<slug>/<key>/"        # 200 without cookie if key valid

# pages.dev must not be an open origin
curl -sI "https://<project>.pages.dev/" | head -5
curl -sI "https://<project>.pages.dev/s/<slug>/<key>/" | head -5  # 403
```

## Notes

- A shortlink to `/a/…` stays blocked by Access for outsiders.
- Share shortlinks should target `/s/<slug>/<key>/` (or Shlink → that URL).
- Trust boundary: only trusted team members publish HTML. Published artifacts may execute JavaScript on the Forge origin, so prefer self-contained HTML and avoid untrusted third-party scripts.
- See also [share-model.md](./share-model.md) and [cloudflare-pages.md](./cloudflare-pages.md).

## References

- [Cloudflare Access self-hosted](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
- [Bypass policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
