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
| `0` | ready (`ok && deploy_ready`) — offline: the values are present, not proven live | Continue. If the deploy then fails on auth or a missing project, run `forge-doctor.sh --online` to name the broken live check (rotated token · deleted Pages project · wrong KV id), then stop and name **/forge-setup**. |
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

## Hub drift guard

Every publish is a full Pages snapshot from this machine's hub copy. The KV
guard, plus the re-assert `deploy_pages` runs immediately before `wrangler`,
are the only cross-machine protection — nothing serializes two machines, so
silencing either can delete a teammate's deck.

| Refusal | Override | Agent action |
|---|---|---|
| Proven unexpected removal (exit 3), record verifiable | `--allow-removals` | **Stop.** Tell the operator this machine's hub may be behind; let whatever syncs the shared artifacts directory finish, then retry. |
| Proven unexpected removal on a record that cannot be verified (exit 3 while the verdict is `unverified` / `untrusted`) | `--allow-removals` **and** `--allow-unverified` — both, or the run refuses | **Stop.** Do **not** reach for `--allow-removals`: the record no longer describes the live site, so the named slug is not the whole story — other live artifacts may be invisible to the check. Same remedy: refresh this machine's copy, then retry. |
| Cannot verify what is live (exit 4: no/unreadable/unparseable `snapshot:live`, a **denied or failed** KV read, failed live lookup, missing `snapshot.py`, or a record from another deployment) | `--allow-unverified` | **Stop.** Same remedy — refresh this machine's copy, then retry. If the message names a refused `snapshot:live` **read**, the hub is not the problem: report the token's missing Workers KV read scope to the operator. If it names a **lost snapshot record** (still anchored on a previous deployment), propose `--reanchor-snapshot` below. |
| The live deployment changed during this publish (a teammate deployed while this run was building) | none — no flag lifts it | **Re-run** the publish. This is the guard working: the other publish won, and re-running rebuilds against the current state. Never override. |
| The guard never observed the live deployment (its lookup failed, or it was skipped for an unresolved artifacts root) | `--allow-unverified` | **Stop.** This is not a teammate deploying — nothing was observed, so nothing can be compared. Re-run once the Cloudflare API answers; if it names an unresolved artifacts root, the machine config is broken → `/forge-setup`. |

**NEVER** pass `--allow-removals` or `--allow-unverified` to get past a refusal
— not on their own, and not together when the refusal asks for both.
A refusal means this machine's hub copy may be behind the shared copy: stop,
tell the operator to let their sync finish — whatever mechanism syncs the
artifacts directory — then retry. Only the operator decides to delete live
artifacts.

The one recovery command an agent may propose:

```bash
publish.sh --reanchor-snapshot --dry-run   # shows the record it would write
publish.sh --reanchor-snapshot             # operator runs the real one
```

It is **not** an override. It rewrites only the snapshot record's
`deployment_id` / `at`, preserving the recorded slug set, for the one case where
a deploy succeeded but the record's KV write was refused — which leaves every
later publish `untrusted`. It never builds and never deploys, so it cannot
touch the live site; it repairs bookkeeping. Propose it (with `--dry-run`
first) and let the operator run it.

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
"$S" --rebuild-index --force-og   # re-render every OG card, not only the stale ones
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
| `~/.config/silex/forge.env` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FORGE_SHARES_KV_ID`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `SHLINK_API_URL` |
| Env override | `FORGE_REPO`, `FORGE_CONFIG`, `FORGE_ENV` |

`public_host` and `pages_project` are read from `forge.config.json` only — no
`PUBLIC_HOST` / `FORGE_PAGES_PROJECT` environment override. Point `publish.sh`
at another forge with `FORGE_CONFIG=<path>`.
