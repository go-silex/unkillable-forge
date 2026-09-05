---
name: forge-publish
description: >-
  Publish a standalone HTML artifact to forge.gosilex.com (Cloudflare Access
  internally; optional share via /s/<slug>/<key>/). Triggers: "publish forge",
  "forge publish", "put on forge", "forge.gosilex.com", "publish the deck",
  "forge artifact".
---

# forge-publish — publish to forge.gosilex.com

Publishes a **self-contained HTML** file (or a folder with `index.html`) to the
Silex internal artifact host.

Generating HTML = **`silex-craft@silex-plugins`** (`silex-slides` · `silex-onepager` ·
`silex-cheatsheet`). This skill = **upload only**.

| | |
|---|---|
| Host | `https://forge.gosilex.com` |
| Default | `/a/<slug>/` — **Cloudflare Access** (team) |
| Share | `/s/<slug>/<key>/` — Access Bypass, **key**, unlisted |
| SSOT | **hub** `$artifacts/<slug>/` (path via local forge.config) |
| Deploy | hub → `wrangler pages deploy` (token `~/.config/silex/forge.env`) |

**≠** `demo.gosilex.com` (client demos). **≠** Vercel.  
**No `/p/`** — removed; use `--share` / toolbar **Shared**.

## Config prerequisites

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}}"
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  for _c in \
    "${XDG_DATA_HOME:-$HOME/.local/share}/omp/plugins/node_modules/silex-forge" \
    "$HOME/.omp/plugins/node_modules/silex-forge"
  do
    [ -d "$_c/scripts" ] && FORGE_ROOT="$_c" && break
  done
fi
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  _d="$PWD"
  while [ "$_d" != "/" ]; do
    _c="$_d/.omp/plugins/node_modules/silex-forge"
    [ -d "$_c/scripts" ] && FORGE_ROOT="$_c" && break
    _d="$(dirname "$_d")"
  done
  unset _d
fi
unset _c
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
bash "$FORGE_ROOT/scripts/forge-doctor.sh"
```

`forge-doctor.sh` exit codes (product surface; `load_config.py --doctor` stays 0/1):

| Exit | Meaning | Next |
|---|---|---|
| `0` | ready (`ok && deploy_ready`) | Continue. |
| `1` | hub/config KO | **Stop.** Ask the operator to run **forge-setup** themselves (`/forge-setup`; Codex `$forge-setup`; OMP `/skill:forge-setup`). Do not invent `hub_root`. Do not invoke forge-setup. |
| `2` | hub OK, deploy blocked | **Stop.** Doctor already printed a `→` line per blocker. Ask the operator to run **forge-setup** (it will skip hub steps and go to discover/token). Do not invent `hub_root`. Do not invoke forge-setup. Do not publish. |

Any non-zero doctor exit → stop. Name `/forge-setup`.

`publish.sh` **hard-stops** when hub/config is broken (`doctor()["ok"]` is
false): it prints `issues[]` and names `/forge-setup`. There is no
`ARTIFACTS_ROOT` escape hatch — a partial machine cannot deploy to
`forge.gosilex.com` using the example fallback.

Publish also needs `~/.config/silex/forge.env` (Pages token + account + KV id
+ Access). A missing token is doctor exit 2, not a warning. See repo
`.env.example` (placeholders only).

Local config: `~/.config/silex/forge.config.json` (fallback plugin
`forge.config.example.json`). `pages_project` / `public_host` live in that
file, not in `forge.env`.

## Usage

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}}"
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  for _c in \
    "${XDG_DATA_HOME:-$HOME/.local/share}/omp/plugins/node_modules/silex-forge" \
    "$HOME/.omp/plugins/node_modules/silex-forge"
  do
    [ -d "$_c/scripts" ] && FORGE_ROOT="$_c" && break
  done
fi
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  _d="$PWD"
  while [ "$_d" != "/" ]; do
    _c="$_d/.omp/plugins/node_modules/silex-forge"
    [ -d "$_c/scripts" ] && FORGE_ROOT="$_c" && break
    _d="$(dirname "$_d")"
  done
  unset _d
fi
unset _c
if [ ! -d "${FORGE_ROOT:-}/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
S="$FORGE_ROOT/scripts/publish.sh"
# in-repo: S=plugins/silex-forge/scripts/publish.sh

# From hub SSOT (path omitted if $artifacts/<slug>/index.html exists)
"$S" <slug> --title "…" --type deck

# From a file/folder (also copies to hub SSOT, then wrangler)
"$S" <slug> <file.html|folder> --title "…" --type deck

# Internal + mint share
"$S" <slug> [path] --share --title "…" --type deck
```

Useful types: `deck` · `talk` · `guide` · `diagram` · `gallery` · `html`.

Other:

```bash
"$S" --share <slug>
"$S" --unshare <slug>
"$S" --list
"$S" --remove <slug>
"$S" --rebuild-index
```

## Rules

1. **Slug** kebab: `^[a-z0-9]+(-[a-z0-9]+)*$`
2. HTML **self-contained** (images as data-URIs) — especially for share links
3. Do **not** publish secrets / cleartext client data
4. Share = secret in the URL — do not paste the key into the catalogue / public Slack
5. Prefer **private** for internal team training decks
6. Generate decks **in the hub** (`artifacts/<slug>/`) then publish

## After publish

- Team URL: `https://forge.gosilex.com/a/<slug>/`
- Share: toolbar **Shared**, or `publish.sh --share <slug>`
- Catalogue (Access): `https://forge.gosilex.com/`
- Hub SSOT updated under `$artifacts/<slug>/`
- Access: see `docs/cloudflare-access.md`

Optional shortlink (`s.gosilex.com/f-<slug>`): Pages `SHLINK_*` and/or local `shlink` CLI — best-effort.

## Env / config

| Source | Keys |
|---|---|
| `~/.config/silex/forge.config.json` | `hub_root`, `artifacts_dir`, `public_host`, `pages_project`… |
| `~/.config/silex/forge.env` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FORGE_SHARES_KV_ID` |
| Env override | `FORGE_REPO`, `PUBLIC_HOST`, `FORGE_CONFIG`, `FORGE_ENV` |
