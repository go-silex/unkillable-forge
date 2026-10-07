# Cloudflare Access — Silex team-prod instance

**Scope:** the **Silex** production forge (`forge.unkillablecompanies.com`, Pages project
`silex-forge`). Configuring your own forge? Do not create these apps by hand and
do not point them at our host — `plugins/silex-forge/scripts/forge-provision.sh`
creates the standard three-application layout on your account, in the safe order, with
your host. Client-owned setup notes live in
[artifacts-config.md](./artifacts-config.md).

## Canonical hostname cutover (2026-10-07)

`forge.unkillablecompanies.com` is the canonical host of the Pages project
`silex-forge`: `PUBLIC_HOST` and the Shlink create URL deployed to Pages point at
it, so share URLs, the CSRF `Origin` check and cookie-authenticated mutations
(`/api/visibility`, `/api/share`) all use it. The `SHARES` KV, the existing share
keys and the Access applications are unchanged — no key was re-minted and no
Access AUD or policy moved.

`forge.gosilex.com` stays registered in Pages, DNS and Access as a legacy host.
At the Cloudflare edge, a redirect rule on the old zone answers `302` for
`GET`/`HEAD` and preserves path and query, so existing links in artifacts, mail
and chat keep working. `/api/*` and `/cdn-cgi/*` are not redirected. Programmatic
clients must use the canonical host: a cookie-authenticated mutation sent to the
legacy host fails the `Origin` check with `csrf_origin`.

The existing login, root Bypass and share Bypass applications each include both
hostnames, with their AUDs, identity providers, team policies and session
durations unchanged. Reusing the login application means that `CF_ACCESS_AUD`
needs no change for either hostname.

Access administration was performed with the BW `cloudflare/global-api-key`
credential (`X-Auth-Email` / `X-Auth-Key`). The scoped
`cloudflare/gosilex-api-token` works for DNS but returns an empty Access app list;
that response is not evidence that the applications are absent.

Validation of the host pair included a real Access-issued JWT with a temporary,
exact-token, IP-restricted service policy and a five-minute session. A deployed
private artifact returned `200` with the cookie and `302` without it, including its
private image resource. The temporary policy and service credential were
removed, and the original policies were verified unchanged. An interactive
Google sign-in was not exercised.


## Goal

| Path | Who |
|---|---|
| `/` catalogue shell · `/a/<slug>/` | Team (Access JWT) unless visibility is **public** |
| `/s/<slug>/<key>/` | Anyone with the secret link (Access **Bypass**) |
| `/login` | Access **Allow** team — issues the JWT cookie Functions read, then sends the visitor back to `?next` |
| `*.pages.dev` | Denied by middleware on every path |

Open `/p/` paths are **gone**. External share = keyed `/s/…` only.

## Apps (Zero Trust)

After Functions are live and `/` answers `x-forge-acl: vis-v4` while
`/a/<slug>/` still answers `302 → /login`:

| App | Domain path | Policy |
|---|---|---|
| **Silex Forge · login** | `forge.unkillablecompanies.com/login`, `forge.gosilex.com/login` | Existing Allow team emails + Mickael policies |
| **Silex Forge** | `forge.unkillablecompanies.com`, `forge.gosilex.com` | Host-wide **Bypass** everyone; Functions enforce visibility |
| **Silex Forge · share public** | `forge.unkillablecompanies.com/s`, `forge.gosilex.com/s` | **Bypass** everyone; Function requires the KV share key |
| **Silex Forge · pages.dev** | `<project>.pages.dev` | Allow team + middleware 403 on every path |

**Order matters:** deploy fail-closed Functions **first**, verify the header, then flip host Bypass. Bypass before Functions = public leak. `forge-provision.sh` enforces this: its Bypass stage is unreachable until both checks below pass on the live host — either one failing aborts the wizard, there is no "continue anyway". Configuring by hand, run them yourself:

```bash
# 1 · the engine is live: the public shell is the only surface that stamps the
#     ACL header (middleware sends "/" through withAcl)
curl -sS -I "https://<your-host>/" | grep -i x-forge-acl        # must print vis-v4

# 2 · the engine fails closed: a private artifact must redirect, not answer.
#     No -L — following the redirect reaches /login, a public shell, which
#     does carry the header and would look like a pass.
curl -sS -I "https://<your-host>/a/<any-slug>/"                 # must be 302, location: /login?next=%2Fa%2F<any-slug>%2F
```

An artifact path never carries `x-forge-acl` when it fail-closes: `loginRedirect()` answers before `withAcl()` runs. Checking for the header on `/a/…` therefore fails on a *correctly* configured forge. A `200` on check 2 means the origin is serving artifacts anonymously — do not create a Bypass policy until it is a `302`.

### Login round-trip

```
/a/<slug>/ (no JWT) → 302 /login?next=%2Fa%2F<slug>%2F
  → Access login → callback sets CF_Authorization → /login?next=… (JWT)
  → middleware 302 /a/<slug>/
```

`next` is resolved with the URL parser and kept only if it stays on the same origin (and is not `/login` itself); anything else falls back to `/`. `/login` without a verified JWT serves `login.html`, which never redirects. `site/_redirects` must not map `/login` → `/login.html`: Pages already answers `/login.html` with `308 → /login`, so that rule is an infinite loop.

| Origin | Catalogue + `/a` | Share `/s` |
|---|---|---|
| `forge.unkillablecompanies.com` (canonical) | Worker visibility | Function + KV |
| `forge.gosilex.com` (legacy; web navigation redirects here) | Same Worker visibility and Access login AUD | Same Function + KV |
| `<project>.pages.dev` | middleware 403 | middleware 403 |

## Setup checklist

Cloudflare account that owns the zone · zone for your public host.

Order: login app (1) → JWT env in place (4) → deploy the Functions
(`publish.sh --rebuild-index`) and run both checks above on the live host →
Bypass app (2) → `pages.dev` app (3). `publish.sh` injects
`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` from `forge.env` at deploy, so step 4
is really "have those two keys in `forge.env`". `forge-provision.sh` follows the
same dependency order and refuses to reach the Bypass step until both checks
pass.

### 1. Self-hosted app (login)

1. [Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → **Add**
2. Self-hosted · path `/login` on the forge host
3. Policy **Allow** → emails ending in your team domain (or IdP group)
4. Session duration as you prefer

### 2. Bypass for Functions-gated paths

**Only after** `/` returns `x-forge-acl: vis-v4` **and** `/a/<slug>/` returns `302 → /login`.

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
curl -sI "https://forge.unkillablecompanies.com/login"                 # 302 → Access
curl -sI "https://forge.unkillablecompanies.com/a/<private-slug>/"      # 302 without cookie
curl -sS -o /dev/null -w '%{http_code}\n' "$EXISTING_SHARE_URL" # GET: 200 without cookie if key valid; never print the key

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
