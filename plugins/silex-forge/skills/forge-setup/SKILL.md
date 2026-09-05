---
name: forge-setup
description: >-
  One-time machine config for silex-forge — local silex-hub path and
  artifacts folder. Operator-invoked only (do not run unless asked).
---

# forge-setup — machine config for silex-forge

Configure the **local silex-hub path** (differs per person) and the central
artifacts folder. Without this config, forge-publish stops and asks you to
run this skill. Do not invent a path.

## Long-term model

| Layer | Where | Role |
|---|---|---|
| **SSOT artifacts** | `$hub_root/$artifacts_dir/<slug>/` | HTML source in the vault |
| **Live deploy** | `wrangler pages deploy` | Direct Upload (token in `forge.env`) |
| **Machine config** | `~/.config/silex/forge.config.json` | personal hub path + `pages_project` / `public_host` (not git) |
| **Credentials** | `~/.config/silex/forge.env` | token, account, KV, Access — never host/project |
| **Defaults** | plugin `forge.config.example.json` | fallback if no local file |

Relative paths like `../silex-hub` are **not** portable → always an **absolute**
path in the local config.

`pages_project` and `public_host` SSOT is `~/.config/silex/forge.config.json`.
`forge.env` is credentials-only. Two things **create** that config: this skill
(step 2), and `forge-provision.sh` (its stage 9 writes the host and project it
prompted for). `forge-discover.sh --write` may persist `pages_project` into an
**existing** file and never creates it.

## Exit criteria

Reached only after the last configuration step (token) and the final
`forge-doctor.sh --online`. Do not print the report before that.

```
✅ ~/.config/silex/forge.config.json (merged from example; this skill creates it)
✅ hub_root = valid vault per vault_markers
✅ $hub_root/$artifacts_dir exists
✅ ~/.config/silex/forge.env (discover --write fills account + KV + Access; token still required, chmod 600)
✅ forge-doctor.sh --online exit 0 — ready (hub OK AND deploy_ready AND online_ok)
⚠️ optional Shlink shortlinks — Pages SHLINK_* + local CLI (step 6b)
⚠️ recommended external craft plugins (step 7)
```

An offline `forge-doctor.sh` exit 0 is **not** the criterion: it only proves the
values are filled in. A revoked token or a deleted Pages project still reads as
ready offline, so `--online` decides — in step 8, and on step 0's exit-`0`
shortcut.

Missing token is **deploy blocked** (doctor exit 2), not hub KO (exit 1).

## Runtime (fail-closed)

Supported: Linux `bash` ≥ 3.2, macOS stock `/bin/bash` 3.2, Windows **WSL**.
**Not supported:** Git Bash / PowerShell (`python3` missing on PATH, no
`chmod 600`). Use WSL.

`python3` ≥ 3.9 (stdlib only) is required. Later steps shell `python3`.

```bash
command -v python3 >/dev/null 2>&1 || {
  echo "python3 ≥ 3.9 is required. Git Bash / PowerShell are not supported — use WSL." >&2
  echo "→ install python3, or rerun this skill inside WSL" >&2
  exit 1
}
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || {
  echo "python3 ≥ 3.9 is required" >&2
  exit 1
}
```

## Shell setup

Run once at the start of the shell session. Later steps assume `$FORGE_ROOT` is set.

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
```

## Step 0 — Doctor

Product surface is `forge-doctor.sh` (exit 0 / 1 / 2). Do **not** use
`load_config.py --doctor` for this branch — that lib flag stays 0/1.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
S="$FORGE_ROOT/scripts/forge-doctor.sh"
# in-repo:
# S=plugins/silex-forge/scripts/forge-doctor.sh
bash "$S"
bash "$S" --json   # machine-readable if needed; payload shape unchanged
```

Flags: `--json` / `-j`, `--quiet` / `-q`, `--online`, `-h` / `--help`. No others.

| Exit | Meaning | Next |
|---|---|---|
| `0` | ready (`ok && deploy_ready`) — **offline** only: every value is filled in, none is proven to work | Run the **live check** below before declaring anything done. |
| `1` | hub/config KO (`!ok`, or missing `lib/` / `python3`) | Continue **step 1**. Do not invent a path. |
| `2` | hub OK, deploy blocked (`ok && !deploy_ready`) | Do **not** redo steps 1–4. Follow the `→` lines doctor printed, then **step 5**. |

On exit `0` the token is already present (`deploy_ready` requires it), so the
live check can run now — and must: an offline `0` still says ready with a
revoked token or a deleted Pages project. Doctor's own last line points here.

```bash
: "${S:?bind S in the § Step 0 block above first}"
bash "$S" --online
```

| `--online` exit | Next |
|---|---|
| `0` | Machine is ready. Optional step 6b + step 7 if missing, then **step 8** (report). Skip steps 1–6. |
| `2` | The live checks failed (rotated token, deleted project, wrong KV id). Quote the `✗` / `→` lines; resume at the named step — **step 5** (discover / provision) or **step 6** (token). Do not claim setup complete. |
| `1` | Config went KO between the two runs. Continue **step 1**. |

On exit `1` or `2`, `--online` is **not** run here: the token is step 6, so the
live check would fail closed on a machine that is merely unfinished.

Exit 2 arrow lines (quoted from `forge-doctor.sh`; `${ENV}` = resolved
`forge.env` path, default `~/.config/silex/forge.env`):

```
→ cf token : add CLOUDFLARE_API_TOKEN to ${ENV} (chmod 600)
→ cf acct  : add CLOUDFLARE_ACCOUNT_ID to ${ENV}   (forge-discover.sh prints it)
→ shares kv: forge-discover.sh --write   (or forge-provision.sh on a new account)
→ access   : add CF_ACCESS_TEAM_DOMAIN to ${ENV}   (forge-discover.sh --write)
→ access   : add CF_ACCESS_AUD to ${ENV}   (forge-discover.sh --write)
→ env perms: chmod 600 ${ENV}
→ <unknown-code>: see forge-doctor.sh --json
  once fixed: forge-doctor.sh --online
```

`deploy_blockers` codes: `token`, `account_id`, `kv_id`, `CF_ACCESS_TEAM_DOMAIN`,
`CF_ACCESS_AUD`, `forge_env_permissions`. An empty `public_host` is a config
**issue**, not a blocker: it makes doctor exit **1**, so no arrow is printed for
it — fix it in step 2 / 5a.

On exit 2, after the arrows:

- `forge_env_permissions` → `chmod 600` on that env file, then continue
- only `token` remaining → skip to **step 6**
- `account_id` / `kv_id` / Access → **step 5** (do not redo hub)

## Step 1 — Resolve hub_root

Skip if step 0 exited 0 or 2.

Do not invent a path. List candidates (best first); **propose** the first one
and **confirm** with the operator before using it.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
python3 "$FORGE_ROOT/scripts/lib/load_config.py" --print-hub-candidates
```

One line per candidate, format `<origin>\t<path>`. Origins: `config`, `env`,
`hub-root-file`, `walk-up`, `known-path`. Empty output → no candidate; **ask
for the absolute vault path** (one question).

**Required** validation before writing: `hub_root` must satisfy `vault_markers`
in the config (a forge outside the Silex vault uses `[]` — the folder must
exist; otherwise named marker directories must exist under it). If KO → do
not write. Explain the vault lives outside the forge repo. Step 2's snippet
enforces this via `vault_ok` / `resolve_vault_markers` / `infer_hub_layout`.

### Bind `HUB` (required before step 2)

There is no `HUB=` anywhere else. After the operator confirms a candidate (or
supplies an absolute path), assign it. Step 2 **must not run** when `HUB` is
empty or relative.

```bash
HUB="<absolute path confirmed by the operator>"
case "$HUB" in
  /*) ;;
  *)
    echo "HUB must be an absolute path (got: ${HUB:-empty})" >&2
    echo "→ re-run step 1; propose a candidate then confirm. Never invent a path." >&2
    exit 1
    ;;
esac
```

## Step 2 — Write local config

Skip if step 0 exited 0 or 2. Requires `$HUB` from the bind step.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
: "${HUB:?bind HUB to an absolute path before step 2}"
case "$HUB" in
  /*) ;;
  *)
    echo "HUB must be an absolute path (got: $HUB)" >&2
    echo "→ re-run step 1; propose a candidate then confirm. Never invent a path." >&2
    exit 1
    ;;
esac
mkdir -p ~/.config/silex
chmod 700 ~/.config/silex

EXAMPLE="$FORGE_ROOT/forge.config.example.json"
# in-repo: plugins/silex-forge/forge.config.example.json
LOCAL=~/.config/silex/forge.config.json
# Operator input never reaches Python source: quoted <<'PY' + os.environ, the
# same shape forge-provision.sh stage 9 uses.
FORGE_LIB="$FORGE_ROOT/scripts/lib" \
HUB="$HUB" EXAMPLE="$EXAMPLE" LOCAL="$LOCAL" python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["FORGE_LIB"])
from load_config import (
    infer_hub_layout,
    pick_forge_repo,
    resolve_vault_markers,
    vault_ok,
)

raw = os.environ["HUB"]
if not raw.startswith("/"):
    print("HUB must be an absolute path (got: %r)" % (raw or "empty"), file=sys.stderr)
    print("→ re-run step 1; propose a candidate then confirm. Never invent a path.", file=sys.stderr)
    sys.exit(1)

example = Path(os.environ["EXAMPLE"])
local = Path(os.environ["LOCAL"])
hub = Path(raw).expanduser().resolve()

base = json.loads(example.read_text(encoding="utf-8"))
over = {}
if local.is_file():
    over = json.loads(local.read_text(encoding="utf-8"))
    base.update({k: v for k, v in over.items() if v not in ("", None)})

local_artifacts = "artifacts_dir" in over and over.get("artifacts_dir") not in ("", None)
local_markers = "vault_markers" in over
if not local_artifacts or not local_markers:
    artifacts_dir, vault_markers = infer_hub_layout(hub)
    if not local_artifacts:
        base["artifacts_dir"] = artifacts_dir
    if not local_markers:
        base["vault_markers"] = vault_markers

markers, markers_issue = resolve_vault_markers(base)
if markers_issue:
    print(markers_issue, file=sys.stderr)
    print("→ fix vault_markers in the local config, or confirm a different hub path", file=sys.stderr)
    sys.exit(1)
if not vault_ok(hub, markers):
    if markers:
        print(
            "hub_root is not a vault (markers %s): %s"
            % (", ".join(markers), hub),
            file=sys.stderr,
        )
    else:
        print("hub_root is not an existing directory: %s" % hub, file=sys.stderr)
    print("The vault lives outside the forge repo. Do not write.", file=sys.stderr)
    print("→ confirm an absolute vault path with the operator (step 1)", file=sys.stderr)
    sys.exit(1)

base["hub_root"] = str(hub)
base["forge_repo"] = pick_forge_repo(base.get("forge_repo") or "")
local.write_text(json.dumps(base, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("wrote %s" % local)
print("hub_root=%s" % base["hub_root"])
print("artifacts_dir=%s" % base["artifacts_dir"])
print("forge_repo=%s" % base["forge_repo"])
PY
```

Never commit `forge.config.json` into silex-forge.

`forge_repo` defaults to HTTPS. A local engine is used only when `forge_repo`
is already a path or `FORGE_REPO` is set.

Optional: sync Silex `hub-root` if absent:

```bash
if [ ! -f ~/.config/silex/hub-root ]; then
  echo "$HUB" > ~/.config/silex/hub-root
fi
```

## Step 3 — Artifacts folder

Skip if step 0 exited 0 or 2.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
ART="$(python3 "$FORGE_ROOT/scripts/lib/load_config.py" --print-artifacts)"
[ -n "$ART" ] || {
  echo "artifacts path empty — hub_root is not set" >&2
  echo "→ re-run step 1–2 (confirm HUB, write local config)" >&2
  exit 1
}
mkdir -p "$ART"
echo "artifacts: $ART"
if [ ! -f "$ART/README.md" ]; then
  cat > "$ART/README.md" <<'EOF'
# Forge artifacts (SSOT)

HTML source per slug: `<slug>/index.html` (+ assets).

- Live publish: skill `forge-publish` → wrangler Pages (not git)
- Do not store secrets / share keys here
- Optional meta: `<slug>/meta.json` (title, type, description)
EOF
fi
```

## Step 4 — Local hub check

Skip if step 0 exited 0 or 2.

Hub only. **No `--online` here** (token is still step 6, so a live check would
fail closed on a machine that is merely unfinished). The live check runs in
**step 8**, and on the exit-`0` shortcut below.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
bash "$FORGE_ROOT/scripts/forge-doctor.sh"
```

| Exit | Next |
|---|---|
| `0` | Hub + deploy credentials already complete — **offline**. Skip steps 5–6 unless override. Optional 6b + 7, then **step 8**, which runs `--online`: nothing is reported ready before that live check passes. |
| `1` | Hub still KO. **Stop.** Name the issues. Do not invent a path. Operator reruns `/forge-setup`. |
| `2` | Hub OK, deploy blocked. Continue **step 5**. Follow the `→` lines. |

Do **not** print the setup report here.

## Step 5 — Cloudflare account, then discover

Probe the logged-in Cloudflare account. OAuth (`wrangler login`) is enough —
no API token. This does **not** make deploy work without a token: `publish.sh`
still requires `CLOUDFLARE_API_TOKEN` in `forge.env`. Discovery only fills
the other keys.

`hub_root` is local (step 1). Cloudflare cannot see it.

### 5a — Account fork (before any discover)

One question: is this the **shared Silex** Cloudflare account, or the
**client's own** account?

**Shared Silex** — keep `public_host=forge.gosilex.com` and
`pages_project=silex-forge` from the example config. Continue 5b with no
`--project` unless doctor/discover already named a different one.

**Client's own account** — do **not** inherit `forge.gosilex.com` /
`silex-forge`. Ask (one at a time) for the public host (no `https://`) and
the Pages project name. Persist them into the **existing** local config
(this skill already created it; never create the file here):

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
HOST="<confirmed public host, no https://>"
PROJECT="<confirmed Pages project name>"
case "$HOST" in
  *://*|*/*)
    echo "public host must be bare — no scheme, no path (got: $HOST)" >&2
    echo "→ ask the operator for the host (e.g. forge.acme.com)" >&2
    exit 1
    ;;
  ""|*[!a-z0-9.-]*|.*|*.|*..*)
    echo "public host must be a lowercase hostname — letters, digits, dots, dashes (got: ${HOST:-empty})" >&2
    echo "→ ask the operator for the host (e.g. forge.acme.com)" >&2
    exit 1
    ;;
  *.*) ;;
  *)
    echo "public host must look like a hostname (got: $HOST)" >&2
    echo "→ ask the operator for the host (e.g. forge.acme.com)" >&2
    exit 1
    ;;
esac
case "$PROJECT" in
  ""|*[!a-z0-9-]*)
    echo "invalid Pages project name: ${PROJECT:-empty}" >&2
    echo "→ Cloudflare Pages accepts lowercase letters, digits and dashes only" >&2
    echo "→ ask the operator for the Pages project name" >&2
    exit 1
    ;;
esac
LOCAL=~/.config/silex/forge.config.json
# Operator input never reaches Python source: quoted <<'PY' + os.environ.
LOCAL="$LOCAL" HOST="$HOST" PROJECT="$PROJECT" python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

local = Path(os.environ["LOCAL"])
if not local.is_file():
    print("no local config — run hub steps first (step 2 writes it)", file=sys.stderr)
    print("→ rerun forge-setup from step 1", file=sys.stderr)
    sys.exit(1)
base = json.loads(local.read_text(encoding="utf-8"))
base["public_host"] = os.environ["HOST"]
base["pages_project"] = os.environ["PROJECT"]
local.write_text(json.dumps(base, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("public_host=%s" % base["public_host"])
print("pages_project=%s" % base["pages_project"])
PY
```

On an **empty** client account (no Pages projects), `forge-provision.sh` is
the entry point — do not discover first:

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
bash "$FORGE_ROOT/scripts/forge-provision.sh"
```

No flags. The wizard is **re-runnable**: Ctrl-C is safe; re-run restores
values already saved in `forge.env` (Enter keeps the previous answer). Do
**not** start a second Pages project — resume the same wizard.

After provision finishes, skip 5b (env is already filled, token included)
and continue at step 6b / 7 / 8 as needed.

### 5b — Discover

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
if [ -n "${PROJECT:-}" ]; then
  bash "$FORGE_ROOT/scripts/forge-discover.sh" --json --project "$PROJECT"
else
  bash "$FORGE_ROOT/scripts/forge-discover.sh" --json
fi
```

Do not dump the JSON in chat. Branch on the exit code (exactly `0` / `1` / `2`):

| Exit | Meaning | Next |
|---|---|---|
| `0` | Forge found, values discovered | `--write` below (keep `--project NAME` if 5a or a retry supplied one), then step 6 for the token only |
| `1` | **Two different classes** — wrangler/login/tooling, **or** a local config prerequisite | Split on the script's message — see below. Never collapse to `wrangler login`. |
| `2` | Named project missing, or the list was unreadable | Other Pages names listed → one question, assign `PROJECT=NAME`, retry 5b (`--json --project` then `--write --project`). Empty list → run `forge-provision.sh` (5a). List **unparsed** → the wrangler output was not understood, so nothing is known about what exists: `--project` would re-parse the same unreadable text. Relink/reinstall the plugin (a wrangler version mismatch is the usual cause), check `wrangler pages project list` by hand, then re-run 5b. Do **not** provision, do **not** retry with `--project`. Provision itself lists existing Pages names and asks `[y/N]` before creating a second project. |

Exit `1`, class A — **tooling / login** (retry this step after fixing):

- `wrangler / npx missing` → install wrangler (`npm i -g wrangler`, or Node.js so `npx` works), then `wrangler login`, retry this step
- `wrangler not logged in` → `wrangler login`, retry this step
- `cannot list Pages projects` → `wrangler login` (needs pages scope), retry this step
- `wrangler pages download config … failed` → tooling/auth; retry after `wrangler login`. Not an exit-2 missing-project.
- `could not classify the Pages project list` / `could not read the discovery payload` / `could not render the discovery payload` → the plugin's parser failed: relink or reinstall the plugin, then re-run 5b

Exit `1`, class B — **local config / filesystem prerequisite**. `wrangler login`
is the wrong command here and a bare retry loops: `--json` never touches these
files, so it keeps exiting `0` while `--write` keeps exiting `1`. Recognise the
message, fix the file, **then** re-run `--write` (unchanged retries are pointless):

| Message contains | Meaning | Remedy |
|---|---|---|
| `is not a JSON object` | `forge.config.json` holds a list/string/number | Make it a JSON object again, or re-run this skill from step 2 to rewrite it |
| `cannot read` / `could not remember pages_project` | the config is unreadable or invalid JSON | Repair the JSON (or move it aside and re-run step 2), then `forge-discover.sh --write` |
| `cannot write` | the config's directory or the file is read-only | Fix the permissions on `~/.config/silex` (`chmod 700`) and the file, then `--write` |
| `cannot create` `<dir>` | `~/.config/silex` cannot be created | `mkdir -p ~/.config/silex && chmod 700 ~/.config/silex`, then `--write` |
| `could not be chmod 600` | credentials were written but are not private | `chmod 600 ~/.config/silex/forge.env` **now**, then `--write` to verify |

Class B fires **after** `forge.env` was written, so the run is half-applied:
the credentials are on disk, the project name is not remembered. Do not restart
at step 1 — fix the named file and re-run `--write`.

On exit `0`:

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
if [ -n "${PROJECT:-}" ]; then
  bash "$FORGE_ROOT/scripts/forge-discover.sh" --write --project "$PROJECT"
else
  bash "$FORGE_ROOT/scripts/forge-discover.sh" --write
fi
```

`--write` may be combined with `--project NAME`. Do **not** combine `--json`
and `--write` (last flag wins, the other mode is dropped).

Merges into `~/.config/silex/forge.env` (chmod 600). Prints **key names only**.
`forge.env` holds credentials plus the Access / Shlink Pages vars only — never
`public_host`, never `pages_project`. `--write` persists the confirmed
`pages_project` into an **existing** `~/.config/silex/forge.config.json` (never
creates that file) and never writes `public_host` back from Pages: the config
is the source, Pages the destination. After the first successful `--write`,
later runs need no `--project`.

A half-forged project (missing `FORGE_SHARES_KV_ID` or Access vars) still
exits 0. Each missing key prints `  ! KEY not set on this project` plus a
`    →` line (quoted from `forge-discover.sh`). Follow that line; do not
invent a command. Pages `[vars]` are pushed from local files at deploy time
(`publish.sh` patches wrangler.toml) — the fix is local file + re-deploy,
not a dashboard-only edit:

| Missing key | Printed follow-up |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler login` again, then check `wrangler whoami` prints an account id |
| `FORGE_SHARES_KV_ID` | create the namespace — `wrangler kv namespace create SHARES` — put its id in `FORGE_SHARES_KV_ID` in forge.env, then re-deploy with `publish.sh` (or re-run `forge-provision.sh` on a fresh account) |
| `CF_ACCESS_TEAM_DOMAIN` | set `CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com` in forge.env, then re-deploy with `publish.sh` |
| `CF_ACCESS_AUD` | Zero Trust → Access → the login application → copy its AUD into `CF_ACCESS_AUD` in forge.env, then re-deploy with `publish.sh` (Functions fail closed without it) |
| `SHLINK_API_URL` | only needed for shortlinks — set `SHLINK_API_URL` in forge.env, then re-deploy with `publish.sh` |

Summary line from the script: `forge-doctor.sh` exits 2 while any of these is
missing; re-run `forge-discover.sh --write` after fixing them.

## Step 6 — Cloudflare token (publish)

Without a token you can **write** the hub / generate a deck. You cannot go live.
`publish.sh` requires `CLOUDFLARE_API_TOKEN` even after a successful discovery.

File **never** in git / never dumped by doctor.

Skip if provision already stored the token, or doctor `cf token : OK`.

**Discovery succeeded (step 5b exit 0)** — add only the token to `forge.env`:

```bash
# ~/.config/silex/forge.env (chmod 600)
#   CLOUDFLARE_API_TOKEN=
```

Do not re-ask `CLOUDFLARE_ACCOUNT_ID` or `FORGE_SHARES_KV_ID`.

**Discovery failed (step 5b exit 1)** — split as in 5b; then retry step 5b.
Exit `2` is handled there (`--project` or `forge-provision.sh`), not by
copying `.env.example`.

Order:

1. File already present + doctor `cf token : OK` → skip
2. Password manager available → fill from your ops vault (do **not** echo the token in chat)
3. Otherwise **ask for the token** (one question) and write the same way

Scopes: Pages Write + Read, Account Settings Read, Workers KV Storage Write (CLI `--share` via REST).

**KV fallback:** if the token lacks KV scope (or REST is rejected), `publish.sh`
retries with `wrangler login` OAuth (`wrangler kv … --remote`,
`CLOUDFLARE_API_TOKEN` unset for that call). Deploy still requires a valid
token in `forge.env`.

## Step 6b — Shlink shortlinks (optional)

Best-effort: without Shlink, share = long `/s/<slug>/<key>/` URL (silent fail OK).

### Cloudflare Pages (ops, once — not the laptop skill alone)

| Var | Type | Role |
|---|---|---|
| `SHLINK_API_KEY` | secret | Shlink API key |
| `SHLINK_API_URL` | plain | **full** create URL — **no default** |

Used by Functions (`POST /api/visibility`, `/api/share`) when the toolbar switches to **Shared**.
Local key file for syncing into Pages (optional): `~/.config/silex/shlink-api-key` (chmod 600).
Never commit the key or put it in `forge.config.json`.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
set -a; source ~/.config/silex/forge.env; set +a
eval "$(python3 "$FORGE_ROOT/scripts/lib/load_config.py" --export-env)"
[ -n "${FORGE_PAGES_PROJECT:-}" ] || {
  echo "pages_project missing from local config" >&2
  echo "→ run step 5a (account fork) then forge-discover.sh --write" >&2
  exit 1
}
npx wrangler pages secret list --project-name="${FORGE_PAGES_PROJECT}"
# should list SHLINK_API_KEY; SHLINK_API_URL is a plain Pages var
```

`pages_project` comes from the local config (`FORGE_PAGES_PROJECT` via
`--export-env`), not a hardcoded `silex-forge`.

### Laptop (CLI `publish.sh --share`)

| Need | Role |
|---|---|
| `shlink` CLI on PATH | mint shortlink on `--share` |
| `shlink_domain` in forge config | host printed in the URL |

Without the CLI → warning → long URL.
Laptop does not use `SHLINK_API_URL`; Pages Functions use Pages env only.

## Step 7 — Recommended craft plugins (external)

Not part of `silex-forge`. **Install** (user scope) — hub doctor stays OK
without them, but Halo slides need `silex-craft` + `frontend-slides`.

| Repo | Install |
|---|---|
| `silex-craft@silex-plugins` | **required** — slides / onepager / cheatsheet |
| [frontend-slides](https://github.com/zarazhangrui/frontend-slides) | **required** by `silex-slides` · live host = `forge-publish`, **never Vercel** |
| [diagram-design](https://github.com/cathrynlavery/diagram-design) | optional |
| [huashu-design](https://github.com/alchaincyf/huashu-design) | optional — `npx skills add` (every harness) |

Pick the verb for **this** harness (do not run Claude slash commands on Codex/Grok/OMP):

Claude Code:

```text
/plugin marketplace add go-silex/silex-plugins
/plugin install silex-craft@silex-plugins --scope user

/plugin marketplace add https://github.com/zarazhangrui/frontend-slides
/plugin install frontend-slides@frontend-slides --scope user

/plugin marketplace add https://github.com/cathrynlavery/diagram-design
/plugin install diagram-design@diagram-design --scope user
```

Grok:

```bash
grok plugin marketplace add go-silex/silex-plugins
grok plugin install silex-craft --trust
grok plugin marketplace add https://github.com/zarazhangrui/frontend-slides
grok plugin install frontend-slides --trust
grok plugin marketplace add https://github.com/cathrynlavery/diagram-design
grok plugin install diagram-design --trust
```

Codex (verb is `plugin add`, not `plugin install`; start a new thread after):

```bash
codex plugin marketplace add go-silex/silex-plugins
codex plugin add silex-craft@silex-plugins
codex plugin marketplace add https://github.com/zarazhangrui/frontend-slides
codex plugin add frontend-slides@frontend-slides
codex plugin marketplace add https://github.com/cathrynlavery/diagram-design
codex plugin add diagram-design@diagram-design
```

Oh My Pi:

```bash
omp plugin marketplace add go-silex/silex-plugins
omp plugin install silex-craft@silex-plugins
omp plugin marketplace add https://github.com/zarazhangrui/frontend-slides
omp plugin install frontend-slides@frontend-slides
omp plugin marketplace add https://github.com/cathrynlavery/diagram-design
omp plugin install diagram-design@diagram-design
```

Every harness:

```bash
npx skills add alchaincyf/huashu-design
```

## Step 8 — Final doctor (`--online`) and report

Last configuration step (token) must already have run. Now the online check
can succeed.

```bash
: "${FORGE_ROOT:?run § Shell setup first}"
bash "$FORGE_ROOT/scripts/forge-doctor.sh"
bash "$FORGE_ROOT/scripts/forge-doctor.sh" --online
```

The verdict is the **`--online`** exit code; the offline run above is only there
to separate a config problem from a live one.

| `--online` exit | Report |
|---|---|
| `0` | Ready. Print the report below. |
| `1` | Hub/config KO. Do **not** claim setup complete. Name the issues. `→` run this skill from step 1. |
| `2` | Hub OK, deploy blocked. Do **not** claim setup complete. Quote the `→` lines. Continue at the named command (discover / token / `chmod 600` / provision). |

Report (only on exit 0):

```
## forge-setup — report

**config**     : ~/.config/silex/forge.config.json
**hub_root**   : [path OK]
**artifacts**  : [path OK | created]
**doctor**     : exit 0 (`--online` ready)

**Next**
- Generate: `silex-craft@silex-plugins` → write under $artifacts/<slug>/
- Publish: forge-publish (hub → wrangler Pages)
- Generic craft: external plugins above
```

## Config load order (reminder)

1. `FORGE_CONFIG` env (explicit path)
2. `~/.config/silex/forge.config.json`
3. else plugin **`forge.config.example.json`** (defaults; empty `hub_root` → doctor exit 1)

Empty `hub_root` may still bootstrap from `HUB_ROOT` env or `~/.config/silex/hub-root`, but **doctor requires** a valid vault.

## Style

- English, one question at a time
- Never invent a colleague's hub path
- No secrets in config or chat
