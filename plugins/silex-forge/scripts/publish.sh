#!/usr/bin/env bash
# publish.sh — hub SSOT → build site → wrangler pages deploy (Direct Upload)
#
#   publish.sh <slug> [path] [options]
#   publish.sh --share <slug>
#   publish.sh --unshare <slug>
#   publish.sh --list | --remove <slug> | --rebuild-index
#
# Architecture (roxabi-forge shape):
#   SSOT     = $hub/$artifacts_dir/<slug>/  (shared silex-hub, outside git)
#   engine   = git main (plugins, functions, site skeleton) — never the HTML
#   deploy   = wrangler pages deploy site  (token ~/.config/silex/forge.env)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

_ENV_FORGE_REPO="${FORGE_REPO-}"
_ENV_SHLINK_DOMAIN="${SHLINK_DOMAIN-}"

if [ -f "$LIB_DIR/load_config.py" ] && command -v python3 >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'from load_config import export_env; print(export_env())')"
fi

FORGE_REPO="${_ENV_FORGE_REPO:-${FORGE_REPO:-https://github.com/go-silex/silex-forge.git}}"
SHLINK_DOMAIN="${_ENV_SHLINK_DOMAIN:-${FORGE_SHLINK_DOMAIN:-${SHLINK_DOMAIN:-s.gosilex.com}}}"
ARTIFACTS_ROOT="${FORGE_ARTIFACTS_ROOT:-}"
INTERNAL_PREFIX="${FORGE_INTERNAL_PREFIX:-a}"
# forge.config.json is the only source of the host and the Pages project, and
# both are resolved here — before source_cf_credentials reads forge.env — so a
# stale credentials file can never redirect the deploy to another project or
# stamp another host into the deployed [vars]. Point elsewhere with FORGE_CONFIG.
PUBLIC_HOST="${FORGE_PUBLIC_HOST:-forge.gosilex.com}"
PAGES_PROJECT="${FORGE_PAGES_PROJECT:-silex-forge}"
# Exported for patch_wrangler_for_deploy (deployed wrangler.toml [vars]) and for
# the python helpers that read it — not a user-facing override.
export PUBLIC_HOST

# shellcheck source=/dev/null
. "$LIB_DIR/forge_common.sh"
die()  { forge_die "$@"; }
# publish.sh info is ▸ on stdout (tests/callers); lib forge_info is → on stderr.
info() { echo "▸ $*"; }
warn() { forge_warn "$@"; }
ok()   { forge_ok "$@"; }
# test_publish_lock.sh export -f die into lock subshells.
export -f forge_die

GIT() { git -c core.hooksPath=/dev/null "$@"; }

WORK=""
DRY_RUN=false
PUBLISH_LOCK_FD=""
PUBLISH_LOCK_DIR=""
cleanup() {
  if [ -n "${PUBLISH_LOCK_FD:-}" ]; then
    # Only GNU flock was used to take this FD (see acquire_publish_lock).
    flock -u "$PUBLISH_LOCK_FD" 2>/dev/null || true
    eval "exec ${PUBLISH_LOCK_FD}>&-" 2>/dev/null || true
  fi
  if [ -n "${PUBLISH_LOCK_DIR:-}" ]; then
    rmdir "$PUBLISH_LOCK_DIR" 2>/dev/null || true
  fi
  if [ -n "${WORK:-}" ]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

require_forge_config() {
  if [ ! -f "$LIB_DIR/load_config.py" ]; then
    return 0
  fi
  # One python3 call: exit 0 when doctor().ok, else print the issues on stdout.
  local diag line
  if diag=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import sys
from load_config import doctor
d = doctor()
if d.get("ok"):
    sys.exit(0)
for i in d.get("issues") or []:
    print(i)
sys.exit(1)'); then
    return 0
  fi
  warn "forge config KO — publish stopped before touching Cloudflare"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "  ✗ $line" >&2
  done <<<"$diag"
  die "forge config incomplete — run the forge-setup skill (forge-doctor.sh for the full report)"
}

usage() {
  cat <<EOF
Usage:
  publish.sh <slug> [path] [--share] [--title T] [--type TYPE] [--desc D] [--dry-run]
  publish.sh --share <slug>
  publish.sh --unshare <slug>
  publish.sh --list | --remove <slug> | --rebuild-index

  --dry-run : accepted anywhere in argv, for every command — builds and
              validates everything (engine, hub snapshot, wrangler.toml)
              without deploying and without mutating KV.

  SSOT   : \$ARTIFACTS_ROOT/<slug>/  (hub, forge.config)
  Deploy : wrangler pages deploy (token ~/.config/silex/forge.env)
  Engine : main (plugins/functions — no HTML, no payload branch)

  Team    : https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/<slug>/
  Share   : https://${PUBLIC_HOST}/s/<slug>/<key>/
EOF
}

validate_slug() {
  local s="${1-}"
  case "$s" in
    '' )            die "empty slug" ;;
    */*|*..*|. ) die "invalid slug (path): '$s'" ;;
  esac
  [[ "$s" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "invalid slug: '$s'"
  case "$s" in
    index|404|robots|registry|site|a|p|s|images|public|_headers) die "reserved slug: '$s'" ;;
  esac
}

whoami_id() { git config user.email 2>/dev/null || echo "${USER:-unknown}@$(hostname)"; }

materialize_engine() {
  [ -n "${WORK:-}" ] || die "materialize_engine: WORK unset"
  if [ -d "$FORGE_REPO" ] && [ -f "$FORGE_REPO/site/404.html" ]; then
    [ "$(GIT -C "$FORGE_REPO" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
      || die "FORGE_REPO is not a git work tree — use the HTTPS URL or a git checkout"
    mkdir -p "$WORK/repo"
    GIT -C "$FORGE_REPO" archive HEAD | tar -x -C "$WORK/repo" \
      || die "git archive HEAD failed for $FORGE_REPO"
    rm -rf "$WORK/repo/site/a" "$WORK/repo/registry"
    info "engine local $FORGE_REPO (HEAD)"
  else
    info "clone engine $FORGE_REPO (main)"
    GIT clone --depth 1 --branch main --quiet "$FORGE_REPO" "$WORK/repo" \
      || die "clone failed: $FORGE_REPO (branch main) — check GitHub access, or set forge_repo to a local checkout in ~/.config/silex/forge.config.json"
  fi
  [ -d "$WORK/repo/site" ] || die "engine checkout has no site/ skeleton — $FORGE_REPO is not a silex-forge engine"
  [ -f "$WORK/repo/site/404.html" ] || die "site/404.html missing"
}

clone_engine() {
  WORK="$(mktemp -d)"
  materialize_engine
}

# Dry run: the real hub must come out of the run byte-identical — including the
# vault notes hub-index.py writes outside the artifacts dir. So the sandbox is
# a fake *hub root* under $WORK holding a copy of the artifacts subtree only
# (never a cp -a of the real hub root — that is a full Obsidian vault).
#
# The hub root has three independent consumers: this shell (ARTIFACTS_ROOT),
# build-site-from-hub.py and hub-index.py (both via load_config). The config is
# the one seam that covers all three plus any future consumer, so the sandbox
# dumps the *resolved* config with hub_root rewritten and exports FORGE_CONFIG.
# Every other key is copied verbatim: preflight, patch_wrangler and the
# project/host resolution behave exactly as in a wet run.
#
# Runs after WORK exists and before the first hub write; no-op on the wet path.
# require_forge_config and preflight_before_live deliberately run *before* it,
# against the real config, so the gate still validates the real deploy target.
enter_dry_run_sandbox() {
  $DRY_RUN || return 0
  [ -n "${WORK:-}" ] || die "enter_dry_run_sandbox: WORK unset"
  local root="$WORK/hub-root"
  mkdir -p "$root" || die "dry run: cannot create hub sandbox $root"
  local sandbox
  sandbox=$(FORGE_DRY_RUN_HUB_ROOT="$root" \
    PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import json, os
from load_config import load_config
root = os.environ["FORGE_DRY_RUN_HUB_ROOT"]
cfg = load_config()
for k in ("_config_source", "_config_fallback"):
    cfg.pop(k, None)
rel = (cfg.get("artifacts_dir") or "artifacts").strip()
cfg["hub_root"] = root
cfg["artifacts_dir"] = rel
os.makedirs(os.path.join(root, rel), exist_ok=True)
with open(os.path.join(root, "forge.config.json"), "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(os.path.join(root, rel))') \
    || die "dry run: cannot write the sandbox config $root/forge.config.json"
  [ -n "$sandbox" ] || die "dry run: sandbox artifacts dir unresolved"
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -d "$ARTIFACTS_ROOT" ]; then
    cp -a "$ARTIFACTS_ROOT"/. "$sandbox"/ \
      || die "dry run: hub snapshot failed ($ARTIFACTS_ROOT → $sandbox)"
  fi
  export FORGE_CONFIG="$root/forge.config.json"
  ARTIFACTS_ROOT="$sandbox"
  info "dry run — hub sandboxed at $root (real hub untouched)"
}

SCRIPTS() {
  # prefer scripts inside cloned engine (version matching deploy)
  if [ -n "${WORK:-}" ] && [ -d "$WORK/repo/plugins/silex-forge/scripts" ]; then
    echo "$WORK/repo/plugins/silex-forge/scripts"
  else
    echo "$SCRIPT_DIR"
  fi
}

# Build site/a + registry from hub into the engine clone
build_from_hub() {
  local build_py
  build_py="$(SCRIPTS)/build-site-from-hub.py"
  [ -f "$build_py" ] || build_py="$SCRIPT_DIR/build-site-from-hub.py"
  [ -f "$build_py" ] || die "build-site-from-hub.py missing — reinstall the silex-forge plugin, then forge-doctor.sh"
  info "build site from hub SSOT → $WORK/repo"
  PYTHONPATH="$(dirname "$build_py")/lib${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$build_py" --repo-root "$WORK/repo" \
    || die "build-site-from-hub failed — check the hub artifacts under ${ARTIFACTS_ROOT:-<artifacts root>} (each slug needs <slug>/index.html), then retry"
}

# Load token + account from ~/.config/silex/forge.env (never print values)
forge_env_mode() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  stat -c '%a' "$f" 2>/dev/null || stat -f '%OLp' "$f" 2>/dev/null || echo ""
}

require_forge_env_secure() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  local mode
  mode=$(forge_env_mode)
  case "$mode" in
    600|400) return 0 ;;
    * ) die "forge.env permissions ${mode:-unknown} — chmod 600 required before publish" ;;
  esac
}

source_cf_credentials() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  local mode
  mode=$(forge_env_mode)
  case "$mode" in
    600|400|"" ) ;;
    *) warn "forge.env mode $mode — chmod 600 recommended" ;;
  esac
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val#\"}"
    val="${val%\"}"
    val="${val#\'}"
    val="${val%\'}"
    # Credentials plus the Access/Shlink Pages vars only. PUBLIC_HOST and
    # FORGE_PAGES_PROJECT are deliberately absent: forge.config.json owns
    # them, and a stale forge.env line here used to decide which Pages
    # project the deploy landed in while the doctor validated the config.
    case "$key" in
      CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|FORGE_SHARES_KV_ID|CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|SHLINK_API_URL|SHLINK_DOMAIN)
        export "$key=$val"
        ;;
    esac
  done < "$f"
}

# Fetch remote plain Pages vars for deploy patch (raises on API failure — no silent wipe)
fetch_pages_plain_var() {
  local name="$1"
  source_cf_credentials
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import sys
from load_config import PagesEnvFetchError, fetch_pages_plain_var as f
try:
    sys.stdout.write(f(sys.argv[1]))
except PagesEnvFetchError as e:
    print(f"✗ Pages env fetch failed ({e.kind}): {e.message}", file=sys.stderr)
    sys.exit(2)' \
    "$name"
}

preflight_cf_mutations() {
  require_forge_env_secure
  source_cf_credentials
  local pf_json
  pf_json=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import json; from load_config import preflight_mutations; print(json.dumps(preflight_mutations(require_kv=False)))')
  if python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else 1)' <<<"$pf_json"; then
    python3 -c 'import json,sys; d=json.load(sys.stdin); [print("  ⚠", w, file=sys.stderr) for w in d.get("warnings",[])]' <<<"$pf_json" || true
    return 0
  fi
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import json, sys
from load_config import doctor
d = json.load(sys.stdin)
for e in d.get("errors", []):
    print("✗", e, file=sys.stderr)
blockers = doctor().get("deploy_blockers") or []
if blockers:
    print("  deploy blockers:", ", ".join(blockers), file=sys.stderr)' <<<"$pf_json"
  echo "  → forge-doctor.sh              # per-blocker fix commands" >&2
  echo "  → forge-discover.sh --write    # account id / KV id / CF_ACCESS_* from the live account" >&2
  echo "  → CLOUDFLARE_API_TOKEN goes in ~/.config/silex/forge.env (chmod 600)" >&2
  echo "  → /forge-setup                 # rebuild the whole local install" >&2
  die "Cloudflare preflight failed — nothing was mutated"
}

preflight_before_live() {
  source_cf_credentials
  preflight_cf_mutations
}

acquire_publish_lock() {
  local slug="${1:-_global}"
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  local lock_dir="${ARTIFACTS_ROOT}/.forge-locks"
  mkdir -p "$lock_dir"
  local lockfile="${lock_dir}/${slug}.lock"
  # util-linux/BSD flock accepts -w (wait timeout). BusyBox flock does not —
  # `command -v flock` is true on Alpine, then `flock -w 120` errors as
  # "unrecognized option" and we mis-report a lock timeout. Probe first;
  # fall through to the mkdir lockdir if -w is missing.
  if command -v flock >/dev/null 2>&1 \
     && flock -w 0 /dev/null true >/dev/null 2>&1; then
    # bash 3.2: fixed FD (not `exec {var}>`, which needs 4.1+)
    exec 9>"$lockfile" || die "cannot open publish lock: $slug"
    PUBLISH_LOCK_FD=9
    if ! flock -w 120 9; then
      die "publish lock timeout: $slug (another machine/process?)"
    fi
    return 0
  fi
  local waited=0
  local candidate="${lock_dir}/${slug}.lockdir"
  while ! mkdir "$candidate" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -ge 120 ]; then
      die "publish lock timeout: $slug (another machine/process?) — if none is running, remove $candidate"
    fi
    sleep 1
  done
  PUBLISH_LOCK_DIR="$candidate"
}

# Patch cloned wrangler.toml: KV id + Access/Shlink vars from forge.env, host
# from forge.config.json (+ API fallback for vars absent locally)
patch_wrangler_for_deploy() {
  local toml="$1"
  # $2 = --no-fetch-remote: dry run patches from local vars only, so the
  # validation path needs no network.
  local kv="${FORGE_SHARES_KV_ID:-}"
  local team="${CF_ACCESS_TEAM_DOMAIN:-}"
  local aud="${CF_ACCESS_AUD:-}"
  local host="${PUBLIC_HOST:-}"
  local shlink_url="${SHLINK_API_URL:-}"
  [ -n "$kv" ] || die \
    "FORGE_SHARES_KV_ID missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$team" ] || die \
    "CF_ACCESS_TEAM_DOMAIN missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$aud" ] || die \
    "CF_ACCESS_AUD missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$host" ] || die \
    "public_host missing — set it in forge.config.json (forge.env no longer holds the host), then retry"
  [ -f "$toml" ] || die "wrangler.toml missing: $toml"
  # --fetch-remote: preserve all Pages plain_text vars; local managed vars
  # override. The wet path must keep it or the deploy wipes the vars that live
  # only on Pages.
  if [ "${2-}" = "--no-fetch-remote" ]; then
    PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      python3 "$LIB_DIR/patch_wrangler.py" "$toml" "$kv" "$team" "$aud" "$host" "${shlink_url:-}"
    return
  fi
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$LIB_DIR/patch_wrangler.py" --fetch-remote "$toml" "$kv" "$team" "$aud" "$host" "${shlink_url:-}"
}

# Dry-run plan: what the wet deploy would push. cwd is $WORK/repo.
print_deploy_plan() {
  local project="$1" acct="$2"
  local files slugs
  # wc -l pads with spaces on macOS — trim before printing.
  files=$(find site -type f | wc -l | tr -d '[:space:]')
  slugs=$(find "site/${INTERNAL_PREFIX}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | wc -l | tr -d '[:space:]')
  info "dry run — no deploy, no KV mutation"
  echo "  project : ${project}"
  echo "  account : ${acct:0:8}…"
  echo "  host    : ${PUBLIC_HOST}"
  echo "  branch  : main"
  echo "  dir     : ${WORK}/repo/site"
  echo "  files   : ${files}"
  echo "  slugs   : ${slugs} under /${INTERNAL_PREFIX}/"
  echo "  wrangler.toml : patched (local vars only; --fetch-remote skipped)"
  ok "dry run OK — nothing deployed"
}

# Direct Upload — HTML never touches git
deploy_pages() {
  preflight_cf_mutations
  source_cf_credentials
  # Gate on the *exported* env wrangler will consume, not on the resolved
  # config: an empty CLOUDFLARE_API_TOKEN makes wrangler fall back to its own
  # OAuth session, i.e. deploy to whatever account that session owns.
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die \
    "CLOUDFLARE_API_TOKEN not in the publish environment — put it in ~/.config/silex/forge.env (chmod 600), then forge-doctor.sh"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$acct" ] || die \
    "CLOUDFLARE_ACCOUNT_ID not in the publish environment — add it to ~/.config/silex/forge.env (forge-discover.sh prints it), then forge-doctor.sh"
  # Frozen from the config at startup: never re-read after forge.env is sourced.
  local project="$PAGES_PROJECT"
  export CLOUDFLARE_ACCOUNT_ID="$acct"
  cd "$WORK/repo"
  [ -d site ] || die "site/ missing in engine clone"
  [ -f wrangler.toml ] || die "wrangler.toml missing"
  if $DRY_RUN; then
    # Every wet precondition has been checked above; a dry run is a gate, not
    # a preview, so it stops here with the plan and never calls wrangler.
    patch_wrangler_for_deploy "$WORK/repo/wrangler.toml" --no-fetch-remote
    print_deploy_plan "$project" "$acct"
    return 0
  fi
  patch_wrangler_for_deploy "$WORK/repo/wrangler.toml"
  info "wrangler pages deploy site → ${project} (${acct:0:8}…)"
  local wr_cmd
  wr_cmd=$(forge_wrangler) || die "wrangler / npx missing — npm i -g wrangler (or install Node so npx wrangler works), then retry"
  # shellcheck disable=SC2086
  $wr_cmd pages deploy site \
    --project-name="$project" \
    --branch=main \
    --commit-dirty=true \
    || die "wrangler pages deploy failed"
  ok "live https://${PUBLIC_HOST}/"
}

write_hub_meta() {
  # env: SLUG TITLE TYP DESC DAY SHARED OUT INTERNAL_PREFIX
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  mkdir -p "${ARTIFACTS_ROOT}/${SLUG}"
  python3 - <<'PY'
import json, os
from pathlib import Path
slug = os.environ["SLUG"]
prefix = os.environ.get("INTERNAL_PREFIX", "a")
p = Path(os.environ["OUT"])
old = {}
if p.is_file():
    try:
        old = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        old = {}
shared = bool(old.get("shared"))
if os.environ.get("SHARED", "") != "":
    shared = os.environ["SHARED"].lower() == "true"
data = {
  "slug": slug,
  "title": os.environ.get("TITLE") or slug,
  "description": os.environ.get("DESC", ""),
  "type": os.environ.get("TYP", "html"),
  "date": os.environ.get("DAY", ""),
  "path": f"/{prefix}/{slug}/",
  "list_on_index": True,
  "visibility": "internal",
  "shared": shared,
}
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("hub meta", p)
PY
}

resolve_source() {
  local input="$1"
  [ -e "$input" ] || die "source not found: $input — pass an existing .html file or a directory containing index.html"
  if [ -f "$input" ]; then
    case "$input" in *.html|*.htm) ;; *) die "expected a .html file: $input" ;; esac
    STAGE="$WORK/src"
    mkdir -p "$STAGE"
    cp -f "$input" "$STAGE/index.html"
    SRC_DIR="$STAGE"
  elif [ -d "$input" ]; then
    [ -f "$input/index.html" ] || die "directory has no index.html: $input — an artifact directory must contain index.html"
    SRC_DIR="$input"
  else
    die "invalid source: $input — expected a .html file or a directory containing index.html"
  fi
}

write_source_to_hub() {
  local slug="$1"
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "ARTIFACTS_ROOT is empty — set artifacts_dir in ~/.config/silex/forge.config.json, then run forge-doctor.sh"
  local dest="${ARTIFACTS_ROOT}/${slug}"
  mkdir -p "$dest"
  # if source is already the hub dir, skip wipe
  if [ "$(cd "$SRC_DIR" && pwd)" = "$(cd "$dest" 2>/dev/null && pwd)" ]; then
    info "source = hub SSOT (in-place)"
    return 0
  fi
  # replace content but keep meta until write_hub_meta
  find "$dest" -mindepth 1 -maxdepth 1 ! -name 'meta.json' -exec rm -rf {} +
  cp -a "$SRC_DIR"/. "$dest"/
  date -u +%Y%m%dT%H%M%SZ > "$dest/build-id.txt"
  ok "hub SSOT ← $dest"
}

gen_og_images() {
  local slug="${1-}"
  local args=()
  [ -n "$slug" ] && args+=(--slug "$slug")
  local sh
  sh="$(SCRIPTS)/gen-og-images.sh"
  if [ -f "$sh" ]; then
    # bash 3.2 + set -u: a bare "${args[@]}" on an empty array is a fatal
    # expansion error, not an empty list. `${a[@]+"${a[@]}"}` is the 3.2-safe form.
    if (cd "$WORK/repo" && bash "$sh" ${args[@]+"${args[@]}"}); then
      ok "og thumbs"
    else
      warn "gen-og-images skip/failed (publish continues)"
    fi
  fi
}

# gen_og_images writes og.jpg under site/; build_from_hub rebuilds site/<prefix>
# from the hub and drops anything the hub does not hold. Persist first.
persist_og_to_hub() {
  local slug="$1"
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  local src="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg"
  [ -f "$src" ] || return 0
  [ -d "${ARTIFACTS_ROOT}/${slug}" ] || return 0
  cp -f "$src" "${ARTIFACTS_ROOT}/${slug}/og.jpg"
}

inject_og_for_slug() {
  local slug="$1" title="$2" desc="$3" path_url="$4"
  local html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  [ -f "$html" ] || return 0
  local img_args=() og_img=""
  if [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" ]; then
    og_img="https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/${slug}/og.jpg"
  elif [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.png" ]; then
    og_img="https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/${slug}/og.png"
  fi
  [ -n "$og_img" ] && img_args=(--image "$og_img")
  python3 "$(SCRIPTS)/inject-og.py" "$html" \
    --title "$title" \
    --description "${desc:-$title}" \
    --url "https://${PUBLIC_HOST}${path_url}" \
    ${img_args[@]+"${img_args[@]}"} \
    || die "inject-og failed"
  # write enhanced HTML back to hub SSOT
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -d "${ARTIFACTS_ROOT}/${slug}" ]; then
    cp -f "$html" "${ARTIFACTS_ROOT}/${slug}/index.html"
    if [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" ]; then
      cp -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" "${ARTIFACTS_ROOT}/${slug}/og.jpg"
    fi
  fi
}

hub_index_update() {
  local slug="${1-}"
  local reg="$WORK/repo/registry"
  [ -d "$reg" ] || return 0
  local hub_args=(--registry "$reg" --host "$PUBLIC_HOST")
  [ -n "$slug" ] && hub_args+=(--slug "$slug")
  if python3 "$(SCRIPTS)/hub-index.py" ${hub_args[@]+"${hub_args[@]}"}; then
    ok "hub index notes"
  else
    warn "hub-index skip"
  fi
}

kv_auth_ok() {
  { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ]; }; }
}

wrangler_bin() {
  forge_wrangler
}

kv_curl() {
  local method="$1" path="$2"
  shift 2
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local ns="${FORGE_SHARES_KV_ID:-}"
  [ -n "$acct" ] || die "CLOUDFLARE_ACCOUNT_ID missing for KV"
  [ -n "$ns" ] || die "FORGE_SHARES_KV_ID missing for KV"
  local url="https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}${path}"
  local -a auth=()
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  else
    auth=(-H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}")
  fi
  curl -sS -w '\n%{http_code}' -X "$method" "$url" ${auth[@]+"${auth[@]}"} "$@"
}

kv_api_success() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)' 2>/dev/null
}

kv_get_key() {
  local key="$1"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local ns="${FORGE_SHARES_KV_ID:-}"
  local url tmp http_code
  tmp=$(mktemp)
  url="https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}/values/${key}"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    http_code=$(curl -sS -o "$tmp" -w '%{http_code}' -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$url" 2>/dev/null) || {
      rm -f "$tmp"
      return 1
    }
  else
    http_code=$(curl -sS -o "$tmp" -w '%{http_code}' \
      -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" \
      "$url" 2>/dev/null) || {
      rm -f "$tmp"
      return 1
    }
  fi
  if [ "$http_code" != "200" ]; then
    rm -f "$tmp"
    return 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

_KV_WRANGLER_OK=0
kv_wrangler_verify() {
  local wb="$1" acct="$2" ns="$3"
  [ "$_KV_WRANGLER_OK" -eq 1 ] && return 0
  local out
  if ! out=$(env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb whoami 2>&1); then
    warn "wrangler OAuth not available — run: wrangler login"
    return 1
  fi
  if ! echo "$out" | grep -qF "$acct"; then
    warn "wrangler OAuth account mismatch (expected ${acct:0:8}…)"
    return 1
  fi
  if ! env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb kv namespace list 2>/dev/null | grep -qF "$ns"; then
    warn "wrangler OAuth cannot see KV namespace ${ns:0:8}…"
    return 1
  fi
  _KV_WRANGLER_OK=1
  return 0
}

# Pages deploy tokens often lack KV API scope; wrangler OAuth may still work.
kv_wrangler() {
  local wb ns="${FORGE_SHARES_KV_ID:-}" acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$ns" ] || return 1
  [ -n "$acct" ] || return 1
  wb=$(wrangler_bin) || return 1
  kv_wrangler_verify "$wb" "$acct" "$ns" || return 1
  # shellcheck disable=SC2086
  env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb "$@" --remote --namespace-id="$ns"
}

kv_put_value() {
  local key="$1" val="$2"
  # Last line of defense: the named dry-run paths refuse before reaching this,
  # so a dry run here is a bug — refuse anyway (no wrangler kv, no HTTP).
  if $DRY_RUN; then
    info "dry run — would put KV ${key} (no mutation)" >&2
    return 0
  fi
  if kv_auth_ok; then
    local resp body code
    resp=$(kv_curl PUT "/values/${key}" -H "Content-Type: text/plain" --data "$val" 2>/dev/null) || true
    body="${resp%$'\n'*}"
    code="${resp##*$'\n'}"
    if [ "$code" = "200" ] && echo "$body" | kv_api_success; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  if ! kv_wrangler kv key put "$key" "$val" >/dev/null 2>&1; then
    return 1
  fi
  local got
  got=$(kv_get_key "$key" 2>/dev/null || true)
  if [ -n "$got" ] && [ "$got" != "$val" ]; then
    warn "KV post-read mismatch for $key"
    return 1
  fi
}

kv_delete_key() {
  local key="$1"
  if $DRY_RUN; then
    info "dry run — would delete KV ${key} (no mutation)" >&2
    return 0
  fi
  if kv_auth_ok; then
    local resp body code
    resp=$(kv_curl DELETE "/values/${key}" 2>/dev/null) || true
    body="${resp%$'\n'*}"
    code="${resp##*$'\n'}"
    if [ "$code" = "200" ] && echo "$body" | kv_api_success; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  if ! kv_wrangler kv key delete "$key" >/dev/null 2>&1; then
    return 1
  fi
  if kv_get_key "$key" >/dev/null 2>&1; then
    warn "KV post-read: $key still present after delete"
    return 1
  fi
}

kv_put_share() {
  kv_put_value "share:$1" "$2"
}

kv_delete_share() {
  kv_delete_key "share:$1"
}

kv_set_visibility() {
  kv_put_value "vis:$1" "$2"
}

kv_activate_share() {
  local slug="$1" key="$2"
  kv_put_share "$slug" "$key" || return 1
  if ! kv_set_visibility "$slug" "shared"; then
    kv_delete_share "$slug" || true
    return 1
  fi
}

kv_revoke_share() {
  local slug="$1"
  if $DRY_RUN; then
    info "dry run — would revoke KV share:${slug} + set vis:${slug}=private (no KV mutation)"
    return 0
  fi
  kv_set_visibility "$slug" "private" || return 1
  kv_delete_share "$slug" || return 1
}

# Fail-closed clear for slug removal/reuse:
#   1) delete share key (link stops working)
#   2) set vis:private tombstone (kept intentionally — NOT deleted)
kv_clear_artifact_auth() {
  local slug="$1"
  if $DRY_RUN; then
    info "dry run — would clear KV share:${slug} + set vis:${slug}=private (no KV mutation)"
    return 0
  fi
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${FORGE_SHARES_KV_ID:-}" ]; then
    warn "KV credentials missing — cannot clear share/vis for $slug"
    return 1
  fi
  kv_delete_key "share:${slug}" || return 1
  kv_set_visibility "$slug" "private" || return 1
  local v
  v=$(kv_get_key "share:${slug}" 2>/dev/null || true)
  [ -z "$v" ] || { warn "post-read: share:${slug} still present"; return 1; }
  v=$(kv_get_key "vis:${slug}" 2>/dev/null || true)
  [ "$v" = "private" ] || { warn "post-read: vis:${slug} tombstone missing"; return 1; }
  return 0
}

mint_key() {
  python3 -c "import secrets; print(secrets.token_urlsafe(18))"
}

maybe_shortlink() {
  local long_url="$1" slug="$2"
  local short_slug="f-${slug}"
  if $DRY_RUN; then
    info "dry run — would mint shortlink https://${SHLINK_DOMAIN}/${short_slug}" >&2
    return 1
  fi
  if ! command -v shlink &>/dev/null; then
    warn "shlink CLI missing — no auto shortlink"
    return 1
  fi
  # Upsert: edit existing short code when possible (no API key in output)
  if shlink short-url:edit --long-url="$long_url" "$short_slug" >/dev/null 2>&1 \
    || shlink update -- "$short_slug" "$long_url" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}"
    return 0
  fi
  if shlink short -- "$long_url" "$short_slug" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}"
    return 0
  fi
  local r
  r=$(python3 -c "import secrets; print(secrets.token_hex(2))")
  if shlink short -- "$long_url" "${short_slug}-${r}" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}-${r}"
    return 0
  fi
  return 1
}

set_hub_shared() {
  local slug="$1" shared="$2"
  local meta="${ARTIFACTS_ROOT}/${slug}/meta.json"
  [ -f "$meta" ] || return 0
  python3 - "$meta" "$shared" <<'PY'
import json, sys
p, shared = sys.argv[1], sys.argv[2].lower() == "true"
d = json.load(open(p, encoding="utf-8"))
for k in ("share_key", "share_path", "share_url", "share_url_query", "short_url"):
    d.pop(k, None)
d["shared"] = shared
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
PY
}

create_share_kv() {
  local slug="$1"
  local key share_path share_url short_url
  key=$(mint_key)
  share_path="/s/${slug}/${key}/"
  share_url="https://${PUBLIC_HOST}${share_path}"
  [ -d "${ARTIFACTS_ROOT}/${slug}" ] || die "hub artifact missing: $slug"

  if kv_activate_share "$slug" "$key"; then
    info "KV share:${slug} + vis:shared OK" >&2
  else
    return 1
  fi
  set_hub_shared "$slug" true
  short_url=""
  if su=$(maybe_shortlink "$share_url" "$slug"); then
    short_url="$su"
  fi
  if [ -n "$short_url" ]; then
    printf '%s\n' "$short_url"
  else
    printf '%s\n' "$share_url"
  fi
}

# Deploy first, then activate share KV — rollback on activation failure after deploy.
create_share_after_deploy() {
  local slug="$1"
  local url
  if $DRY_RUN; then
    # stdout of this function is the share URL its callers print — the refusal
    # goes to stderr, and no key is minted, no KV written, no shortlink called.
    info "dry run — would mint a share key for ${slug} (KV share:${slug} + vis:shared, shortlink https://${SHLINK_DOMAIN}/f-${slug})" >&2
    printf '%s' "https://${PUBLIC_HOST}/s/${slug}/<dry-run-key>/"
    return 0
  fi
  if ! url=$(create_share_kv "$slug"); then
    warn "share KV activation failed after deploy — rolling back"
    kv_revoke_share "$slug" || true
    set_hub_shared "$slug" false
    die "share activation failed — set CLOUDFLARE_API_TOKEN with Workers KV Edit, or wrangler login (OAuth)"
  fi
  printf '%s' "$url"
}

cmd_list() {
  require_forge_config
  info "hub artifacts SSOT ($PUBLIC_HOST)"
  if [ -z "${ARTIFACTS_ROOT:-}" ] || [ ! -d "$ARTIFACTS_ROOT" ]; then
    die "ARTIFACTS_ROOT missing — forge-setup"
  fi
  local d
  for d in "$ARTIFACTS_ROOT"/*/; do
    [ -d "$d" ] || continue
    [ -f "${d}index.html" ] || continue
    python3 - "$d" <<'PY'
import json, sys
from pathlib import Path
d = Path(sys.argv[1])
meta = d / "meta.json"
title = d.name
shared = False
typ = "html"
if meta.is_file():
    try:
        m = json.loads(meta.read_text(encoding="utf-8"))
        title = m.get("title") or title
        shared = bool(m.get("shared"))
        typ = m.get("type") or typ
    except Exception:
        pass
flag = "share" if shared else "     "
print(f"  catalog {flag:5}  /a/{d.name:28}  [{typ}] {title}")
PY
  done
}

cmd_remove() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "ARTIFACTS_ROOT missing"
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  kv_clear_artifact_auth "$slug" || die "KV clear failed for $slug — abort remove (fix credentials and retry)"
  $DRY_RUN || info "KV cleared for $slug (share + vis)"
  if $DRY_RUN; then
    info "dry run — would remove hub artifact ${ARTIFACTS_ROOT}/${slug}"
  else
    rm -rf "${ARTIFACTS_ROOT:?}/${slug}"
    ok "removed from hub SSOT: $slug"
  fi
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  if deploy_pages; then
    hub_index_update
  fi
}

cmd_unshare() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  if kv_revoke_share "$slug"; then
    $DRY_RUN || info "KV share:${slug} revoked + vis:private"
  else
    die "KV revoke failed — share link may still work; fix credentials and retry"
  fi
  if $DRY_RUN; then
    info "dry run — would set hub meta shared=false for ${slug}"
  else
    set_hub_shared "$slug" false
  fi
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  local html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  if [ -f "$html" ]; then
    python3 "$(SCRIPTS)/inject-share-bar.py" "$html" --slug "$slug" || true
    if [ -n "${ARTIFACTS_ROOT:-}" ]; then
      cp -f "$html" "${ARTIFACTS_ROOT}/${slug}/index.html"
    fi
  fi
  deploy_pages || die "deploy failed after unshare"
  ok "share revoked for $slug"
}

cmd_share_only() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  # Fail before any clone/build/deploy: --share on an unpublished slug used to
  # redeploy the whole site and only then die on the missing hub artifact.
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ ! -f "${ARTIFACTS_ROOT}/${slug}/index.html" ]; then
    die "hub artifact missing: ${ARTIFACTS_ROOT}/${slug}/index.html — publish the HTML first (publish.sh ${slug} <file.html>), then publish.sh --share ${slug}"
  fi
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  local html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  if [ -f "$html" ]; then
    python3 "$(SCRIPTS)/inject-share-bar.py" "$html" --slug "$slug" || true
    cp -f "$html" "${ARTIFACTS_ROOT}/${slug}/index.html" || true
  fi
  deploy_pages || die "deploy failed — share not activated"
  local url
  url=$(create_share_after_deploy "$slug")
  ok "share mint"
  echo "  URL:   $url"
  hub_index_update "$slug"
}

inject_share_bars() {
  # Overlay on the deploy tree only (hub stays craft SSOT).
  # SCRIPT_DIR = this file — clone of origin/main may not have the inject yet.
  local inj="$SCRIPT_DIR/inject-share-bar.py"
  [ -f "$inj" ] || inj="$(SCRIPTS)/inject-share-bar.py"
  [ -f "$inj" ] || die "inject-share-bar.py missing"
  local s slug html missing=0
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    slug=$(basename "$s")
    html="${s}index.html"
    [ -f "$html" ] || continue
    python3 "$inj" "$html" --slug "$slug" || warn "share-bar inject failed $slug"
  done
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    slug=$(basename "$s")
    html="${s}index.html"
    [ -f "$html" ] || continue
    if grep -qF '<!-- forge-share-bar -->' "$html"; then
      continue
    fi
    warn "share-bar missing after inject: $slug"
    missing=$((missing + 1))
  done
  [ "$missing" -eq 0 ] || die "share-bar missing on $missing page(s) — abort deploy"
}

cmd_rebuild_index() {
  require_forge_config
  acquire_publish_lock "_global"
  source_cf_credentials
  preflight_before_live
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  gen_og_images
  # og.jpg is written under site/; persist to the hub before rebuilding
  local s
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    persist_og_to_hub "$(basename "$s")"
  done
  build_from_hub
  inject_share_bars
  if deploy_pages; then
    ok "index rebuilt + live on Pages"
    hub_index_update
  fi
}

cmd_publish() {
  local slug="$1"
  shift
  local source="" do_share=false title="" typ="html" desc=""
  if [ $# -gt 0 ] && [[ "${1-}" != --* ]]; then
    source="$1"
    shift
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --share)  do_share=true; shift ;;
      --public) die "--public and /p/ are gone. Use --share." ;;
      --title)  title="${2-}"; shift 2 ;;
      --type)   typ="${2-}"; shift 2 ;;
      --desc)   desc="${2-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 — see publish.sh --help" ;;
    esac
  done
  validate_slug "$slug"
  require_forge_config
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  [ -n "$title" ] || title="$slug"

  # resolve source → always land in hub first
  if [ -z "$source" ]; then
    if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -f "${ARTIFACTS_ROOT}/${slug}/index.html" ]; then
      source="${ARTIFACTS_ROOT}/${slug}"
      info "source hub SSOT: $source"
    else
      die "no source for '${slug}': pass an HTML path (publish.sh ${slug} <file.html>) or write ${ARTIFACTS_ROOT:-<artifacts root>}/${slug}/index.html first"
    fi
  fi

  WORK="$(mktemp -d)"
  enter_dry_run_sandbox
  resolve_source "$source"
  write_source_to_hub "$slug"

  local day
  day="$(date -u +%Y-%m-%d)"
  export SLUG="$slug" TITLE="$title" TYP="$typ" DESC="$desc" DAY="$day"
  export INTERNAL_PREFIX="$INTERNAL_PREFIX"
  export SHARED=""   # preserve existing meta.shared
  export OUT="${ARTIFACTS_ROOT}/${slug}/meta.json"
  write_hub_meta

  # WORK already set; do not call clone_engine (it would reset WORK)
  materialize_engine

  build_from_hub

  local dest path_url
  path_url="/${INTERNAL_PREFIX}/${slug}/"
  dest="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}"
  [ -f "$dest/index.html" ] || die "build missing index for $slug"

  gen_og_images "$slug"
  persist_og_to_hub "$slug"
  inject_og_for_slug "$slug" "$title" "$desc" "$path_url"
  python3 "$(SCRIPTS)/inject-share-bar.py" "$dest/index.html" --slug "$slug" || true
  # persist bar into hub
  cp -f "$dest/index.html" "${ARTIFACTS_ROOT}/${slug}/index.html" || true
  # rebuild registry/index after og inject (og.jpg may be new)
  build_from_hub

  local share_url=""
  if deploy_pages; then
    ok "published (hub SSOT + wrangler Pages)"
    echo "  Team: https://${PUBLIC_HOST}${path_url}  (Access)"
    if $do_share; then
      share_url=$(create_share_after_deploy "$slug")
      echo "  Share:   $share_url  (public, unlisted)"
    fi
    hub_index_update "$slug"
  elif $do_share; then
    warn "deploy failed — share not activated (no KV mutation)"
  fi
}

if [ -n "${FORGE_PUBLISH_LIB_ONLY:-}" ]; then
  # `return` succeeds when sourced; the `exit` runs only when executed.
  # shellcheck disable=SC2317  # reachable via the execute path, not statically
  return 0 2>/dev/null || exit 0
fi
source_cf_credentials

# --dry-run is global: accepted anywhere in argv, for every command. Strip it
# here, before the dispatch, so no per-command parser ever sees it.
_dry_run_args=()
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=true ;;
    *) _dry_run_args+=("$_arg") ;;
  esac
done
set -- ${_dry_run_args[@]+"${_dry_run_args[@]}"}
unset _arg _dry_run_args

case "${1-}" in
  ""|-h|--help) usage; exit 0 ;;
  --list) cmd_list ;;
  --remove)
    [ -n "${2-}" ] || die "usage: --remove <slug>"
    cmd_remove "$2"
    ;;
  --unshare)
    [ -n "${2-}" ] || die "usage: --unshare <slug>"
    cmd_unshare "$2"
    ;;
  --rebuild-index) cmd_rebuild_index ;;
  --share)
    if [ -n "${2-}" ] && [ -z "${3-}" ]; then
      cmd_share_only "$2"
    else
      die "usage: --share <slug>   or   publish.sh <slug> [path] --share"
    fi
    ;;
  *)
    [ -n "${1-}" ] || { usage; exit 1; }
    cmd_publish "$@"
    ;;
esac
