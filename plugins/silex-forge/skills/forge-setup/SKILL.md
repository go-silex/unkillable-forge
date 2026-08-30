---
name: forge-setup
description: >-
  One-time machine config for silex-forge — local silex-hub path and
  artifacts folder.
disable-model-invocation: true
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
| **Machine config** | `~/.config/silex/forge.config.json` | personal hub path (not git) |
| **Defaults** | plugin `forge.config.example.json` | fallback if no local file |

Relative paths like `../silex-hub` are **not** portable → always an **absolute**
path in the local config.

## Exit criteria

```
✅ ~/.config/silex/forge.config.json (merged from example)
✅ hub_root = valid vault (00_COCKPIT + 01_COMPANY)
✅ $hub_root/$artifacts_dir exists
✅ ~/.config/silex/forge.env (Pages token + account + KV id, chmod 600)
✅ forge-doctor exit 0 (missing token = warning, not hub KO)
⚠️ optional Shlink shortlinks — Pages SHLINK_* + local CLI (step 5b)
⚠️ recommended external craft plugins (diagram-design, huashu-design, frontend-slides)
```

## Step 0 — Doctor

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-${OMP_PLUGIN_ROOT:-$HOME/.omp/plugins/node_modules/silex-forge}}}}}"
if [ ! -d "$FORGE_ROOT/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
S="$FORGE_ROOT/scripts/forge-doctor.sh"
# in-repo:
# S=plugins/silex-forge/scripts/forge-doctor.sh
bash "$S"
bash "$S" --json   # machine-readable if needed
```

- **OK** → print hub + artifacts. Still cover token + **step 6** (craft plugins) if missing. Stop unless override requested.
- **KO** → continue setup (do not invent a path).

## Step 1 — Resolve hub_root

Discovery order (propose, **confirm** with the operator):

1. Existing `~/.config/silex/forge.config.json` → `hub_root`
2. `~/.config/silex/hub-root` (shared Silex config)
3. Cwd / walk-up with markers `00_COCKPIT` + `01_COMPANY`
4. Common paths if they exist:
   - `$HOME/projects/gosilex/silex-hub`
   - `$HOME/silex-hub`
   - `$HOME/projects/silex-hub`
   - macOS Drive: list `~/Library/CloudStorage/*/` if needed
5. Otherwise **ask for the absolute vault path** (one question)

**Required** validation before writing:

```bash
HUB="<absolute path>"
test -d "$HUB/00_COCKPIT" && test -d "$HUB/01_COMPANY" && echo "hub OK: $HUB"
```

If KO → do not write. Explain the vault lives outside the forge repo.

## Step 2 — Write local config

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-${OMP_PLUGIN_ROOT:-$HOME/.omp/plugins/node_modules/silex-forge}}}}}"
if [ ! -d "$FORGE_ROOT/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
mkdir -p ~/.config/silex
chmod 700 ~/.config/silex

EXAMPLE="$FORGE_ROOT/forge.config.example.json"
# in-repo: plugins/silex-forge/forge.config.example.json
LOCAL=~/.config/silex/forge.config.json
python3 - <<PY
import json
from pathlib import Path

example = Path("$EXAMPLE")
local = Path("$LOCAL")
hub = Path("$HUB").expanduser().resolve()

base = json.loads(example.read_text(encoding="utf-8"))
if local.is_file():
    over = json.loads(local.read_text(encoding="utf-8"))
    base.update({k: v for k, v in over.items() if v not in ("", None)})
base["hub_root"] = str(hub)
base.setdefault("artifacts_dir", "00_COCKPIT/Forge/artifacts")
local.write_text(json.dumps(base, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {local}")
print(f"hub_root={base['hub_root']}")
print(f"artifacts_dir={base['artifacts_dir']}")
PY
```

Never commit `forge.config.json` into silex-forge.

Optional: sync Silex `hub-root` if absent:

```bash
if [ ! -f ~/.config/silex/hub-root ]; then
  echo "$HUB" > ~/.config/silex/hub-root
fi
```

## Step 3 — Artifacts folder

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-${OMP_PLUGIN_ROOT:-$HOME/.omp/plugins/node_modules/silex-forge}}}}}"
if [ ! -d "$FORGE_ROOT/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
ART="$(python3 "$FORGE_ROOT/scripts/lib/load_config.py" --print-artifacts)"
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

## Step 4 — Final doctor

```bash
FORGE_ROOT="${SILEX_FORGE_PLUGIN_ROOT:-${GROK_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-${OMP_PLUGIN_ROOT:-$HOME/.omp/plugins/node_modules/silex-forge}}}}}"
if [ ! -d "$FORGE_ROOT/scripts" ]; then
  echo "silex-forge: plugin root is unavailable; reinstall or link the plugin for this harness" >&2
  exit 1
fi
bash "$FORGE_ROOT/scripts/forge-doctor.sh"
bash "$FORGE_ROOT/scripts/forge-doctor.sh" --online
```

Report:

```
## forge-setup — report

**config**     : ~/.config/silex/forge.config.json
**hub_root**   : [path OK]
**artifacts**  : [path OK | created]
**doctor**     : ✅|✗

**Next**
- Generate: `silex-craft@silex-plugins` → write under $artifacts/<slug>/
- Publish: forge-publish (hub → wrangler Pages)
- Generic craft: external plugins below
```

## Step 5 — Cloudflare token (publish)

Without a token you can **write** the hub / generate a deck. You cannot go live.

File **never** in git / never dumped by doctor — copy from repo `.env.example`:

```bash
cp /path/to/silex-forge/.env.example ~/.config/silex/forge.env
chmod 600 ~/.config/silex/forge.env
# fill:
#   CLOUDFLARE_ACCOUNT_ID=
#   CLOUDFLARE_API_TOKEN=
#   FORGE_SHARES_KV_ID=
```

Order:

1. File already present + doctor `cf token : OK` → skip
2. Password manager available → fill from your ops vault (do **not** echo the token in chat)
3. Otherwise **ask for the token** (one question) and write the same way

Scopes: Pages Write + Read, Account Settings Read, Workers KV Storage Write (CLI `--share` via REST).

**KV fallback:** if the token lacks KV scope (or REST is rejected), `publish.sh` retries with `wrangler login` OAuth (`wrangler kv … --remote`, `CLOUDFLARE_API_TOKEN` unset for that call). Deploy still requires a valid token in `forge.env`.

## Step 5b — Shlink shortlinks (optional)

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
set -a; source ~/.config/silex/forge.env; set +a
npx wrangler pages secret list --project-name=silex-forge
# should list SHLINK_API_KEY; SHLINK_API_URL is a plain Pages var
```

### Laptop (CLI `publish.sh --share`)

| Need | Role |
|---|---|
| `shlink` CLI on PATH | mint shortlink on `--share` |
| `shlink_domain` in forge config | host printed in the URL |

Without the CLI → warning → long URL.  
Laptop does not use `SHLINK_API_URL`; Pages Functions use Pages env only.

## Step 6 — Recommended craft plugins (external)

Not part of `silex-forge`. **Install** (user scope) — hub doctor stays OK without them, but Halo slides need `silex-craft` + `frontend-slides`.

| Repo | Install |
|---|---|
| `silex-craft@silex-plugins` | **required** — slides / onepager / cheatsheet |
| [frontend-slides](https://github.com/zarazhangrui/frontend-slides) | **required** by `silex-slides` · live host = `forge-publish`, **never Vercel** |
| [diagram-design](https://github.com/cathrynlavery/diagram-design) | optional |
| [huashu-design](https://github.com/alchaincyf/huashu-design) | optional — `npx skills add` |

```text
/plugin marketplace add go-silex/silex-plugins
/plugin install silex-craft@silex-plugins --scope user

/plugin marketplace add https://github.com/zarazhangrui/frontend-slides
/plugin install frontend-slides@frontend-slides --scope user

/plugin marketplace add https://github.com/cathrynlavery/diagram-design
/plugin install diagram-design@diagram-design --scope user
```

```bash
npx skills add alchaincyf/huashu-design
```

## Config load order (reminder)

1. `FORGE_CONFIG` env (explicit path)
2. `~/.config/silex/forge.config.json`
3. else plugin **`forge.config.example.json`** (defaults; empty `hub_root` → doctor KO)

Empty `hub_root` may still bootstrap from `HUB_ROOT` env or `~/.config/silex/hub-root`, but **doctor requires** a valid vault.

## Style

- English, one question at a time
- Never invent a colleague’s hub path
- No secrets in config or chat
