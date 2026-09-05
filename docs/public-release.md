# Going public — checklist

## HEAD (this commit)

- No HTML payloads in tree (`site/a`, `registry`, `manifest.json`)
- No Cloudflare account / KV / Access AUD in committed files
- Secrets only in `~/.config/silex/forge.env` and Pages dashboard

## Git history (required before open-source)

Older commits may still contain:

- `site/a/**`, `site/manifest.json`, `registry/**` (internal catalogue)
- `wrangler.toml` with real KV namespace ID and Access AUDs

**HEAD being clean is not enough.** Run:

```bash
scripts/purge-git-history.sh
# then coordinate force-push with the team:
# git push --force-with-lease origin main
```

Requires [git-filter-repo](https://github.com/newren/git-filter-repo).

## After purge

1. Fresh clone on a clean machine — grep history for known KV/Access id patterns and client slug names
2. Set GitHub **License** field to MIT (matches [LICENSE](../LICENSE))
3. Enable [security policy](https://github.com/go-silex/silex-forge/security/policy) and issue templates
4. Set repo visibility to public
5. Confirm Pages env vars still set (deploy injects from `forge.env`)
6. Tag the release from the top CHANGELOG section (`silex-forge/vX.Y.Z`) — see [CHANGELOG.md](../CHANGELOG.md)

## Ops credentials (never in git)

| File | Contents |
|---|---|
| `~/.config/silex/forge.env` | token, account, KV, Access, `PUBLIC_HOST`, optional `SHLINK_API_URL` |
| Pages secrets | `SHLINK_API_KEY`, `FORGE_SHARE_SECRET` |

Build `forge.env` with `wrangler login` + `forge-discover.sh --write`, not by
copying [`.env.example`](../.env.example). The example is a schema reference
(key names and comments, no values); copying it over a working file wipes the
real credentials. On a fresh Cloudflare account, run
`plugins/silex-forge/scripts/forge-provision.sh` instead.
