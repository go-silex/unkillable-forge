# Share model — forge.gosilex.com

## Why not an open public path (`/p/` — removed)

| Approach | Problem |
|---|---|
| `/p/<slug>/` without a key | Enumeration + large public surface |
| “Public” toggle without a secret | Anyone who guesses the slug reads the doc |
| `?k=` in pure static HTML | Key in JS/HTML is **not** a real gate |
| Key in git registry / `__FORGE_SHARE__` | Durable secret outside KV — **forbidden** |

**Canon:** `/a/` (Access) + `/s/<slug>/<key>/` (Bypass + KV).  
**SSOT for keys** = KV only. Registry may snapshot `shared: bool` without the secret.

## Model

```
Team (Access)                      Outside
─────────────────                  ─────────
/  catalogue  ─────────────────►  302 Access login
/a/<slug>/    ─────────────────►  302 Access login
                                    │
publish --share / toolbar Shared    │
    ▼                               ▼
/s/<slug>/<key>/  ── Bypass ──►  200 if you have the link
                                    (not on the catalogue)
```

- **Key** = high-entropy path segment (`token_urlsafe(18)`)
- **Unlisted**: share does not add a catalogue card
- **Shortlink** (best-effort → `f-<slug>` on your Shlink domain):
  - **Functions**: Pages env `SHLINK_API_KEY` + `SHLINK_API_URL` (full create URL, **no default**) — silent fail OK
  - **CLI** `publish.sh --share`: local `shlink` CLI + `shlink_domain` in forge config
- **Toolbar** on `/a/<slug>/` (team):
  - **Private / Public** — copy `/a/<slug>/`
  - **Shared** — `POST /api/visibility` → `/s/<slug>/<key>/` (+ `shortUrl` if Shlink Pages OK)

## Commands

```bash
publish.sh my-deck ./file.html --share
publish.sh --share my-deck
publish.sh --unshare my-deck
```

## Access (summary)

| Surface | Policy |
|---|---|
| Forge host `/login` | Allow team |
| Forge host `/`, `/a/*`, `/s/*`, `/api/*` | Bypass (Functions enforce) |
| `*.pages.dev` | Allow team + middleware 403 on every path |

Details: [cloudflare-access.md](./cloudflare-access.md).

## Mint on click

1. Toolbar **Shared** on `/a/<slug>/` → `POST /api/visibility` `{ slug, visibility: "shared" }`
2. Back to private → deletes KV share key
3. Pages Function writes the key in KV `SHARES`
4. Returned URL: `/s/<slug>/<key>/` — Function checks KV then serves `/a/<slug>/` via ASSETS
5. Clipboard + toast
6. Rotate via `POST /api/share` `{ slug, rotate: true }` when using the share API

Auth: verified Cloudflare Access JWT on team APIs.  
Publishing is restricted to trusted team members. Artifact HTML is active same-origin content; prefer self-contained output and do not include untrusted third-party scripts.
Ops bypass: header `X-Forge-Share-Secret` on **POST/DELETE `/api/share` only** (Pages secret) — not catalogue, `/a/*`, or `/api/visibility`.

- `GET /api/share` → `{ slug, active }` only (no raw key)
- `POST /api/share` → `{ shareUrl, shortUrl?, … }` once (canonical origin `https://forge.gosilex.com`)
- Share URLs are **never** injected into `/a/` HTML

## Landing = live share state (KV)

Catalogue embeds a registry snapshot (`shared` boolean), then on load (team Access):

- `GET /api/share?slug=…` per artifact
- updates share badge, “with share” count, **Shared** filter
- re-sync on `focus` / `visibilitychange`

Runtime source of truth for share = KV. Registry does **not** store `share_key`.

## `?k=` vs path key

| Form | Example | Status |
|---|---|---|
| Path (canonical) | `/s/my-slug/<key>/` | **Yes** — KV + Function |
| Query (alias) | `/s/my-slug/?k=<key>` | **Yes** — same KV key |
| Query on `/a/…` | `/a/slug/?k=` | No (team Access) |
