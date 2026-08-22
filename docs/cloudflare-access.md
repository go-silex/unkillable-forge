# Cloudflare Access — forge.gosilex.com

## Goal

| Path | Who |
|---|---|
| `/` catalogue shell · `/a/<slug>/` | Team (Access JWT) unless visibility is **public** |
| `/s/<slug>/<key>/` | Anyone with the secret link (Access **Bypass**) |
| `/login` | Access **Allow** team — issues the JWT cookie Functions read |
| `*.pages.dev` | Denied by middleware on every path |

Open `/p/` paths are **gone**. External share = keyed `/s/…` only.

## Apps (Zero Trust)

After Functions are live (`x-forge-acl: vis-v4`):

| App | Domain path | Policy |
|---|---|---|
| **Silex Forge · login** | `forge.gosilex.com/login` | Allow team emails / IdP group |
| **Silex Forge · public surface** | `forge.gosilex.com/`, `/a/*`, `/s/*`, `/api/*` | **Bypass** everyone (Functions enforce visibility) |
| **Silex Forge · pages.dev** | `<project>.pages.dev` | Allow team + middleware 403 on every path |

**Order matters:** deploy fail-closed Functions **first**, then flip host Bypass. Bypass before Functions = public leak.

| Origin | Catalogue + `/a` | Share `/s` |
|---|---|---|
| `forge.gosilex.com` | Worker visibility | Function + KV |
| `<project>.pages.dev` | middleware 403 | middleware 403 |

## Setup checklist

Cloudflare account that owns the zone · zone for your public host.

### 1. Self-hosted app (login)

1. [Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → **Add**
2. Self-hosted · path `/login` on the forge host
3. Policy **Allow** → emails ending in your team domain (or IdP group)
4. Session duration as you prefer

### 2. Bypass for Functions-gated paths

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
