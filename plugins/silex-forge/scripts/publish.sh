#!/usr/bin/env bash
# publish.sh — hub SSOT → build site → wrangler pages deploy (Direct Upload)
#
#   publish.sh <slug> [path] [options]
#   publish.sh --share <slug>
#   publish.sh --unshare <slug>
#   publish.sh --list | --remove <slug> | --rebuild-index
#
# Architecture (roxabi-forge shape):
#   SSOT     = $hub/$artifacts_dir/<slug>/  (silex-hub partagé, hors git)
#   engine   = git main (plugins, functions, site skeleton) — jamais les HTML
#   deploy   = wrangler pages deploy site  (token ~/.config/silex/forge.env)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

_ENV_FORGE_REPO="${FORGE_REPO-}"
_ENV_PUBLIC_HOST="${PUBLIC_HOST-}"
_ENV_SHLINK_DOMAIN="${SHLINK_DOMAIN-}"

if [ -f "$LIB_DIR/load_config.py" ] && command -v python3 >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'from load_config import export_env; print(export_env())')"
fi

FORGE_REPO="${_ENV_FORGE_REPO:-${FORGE_REPO:-git@github.com:go-silex/silex-forge.git}}"
PUBLIC_HOST="${_ENV_PUBLIC_HOST:-${FORGE_PUBLIC_HOST:-${PUBLIC_HOST:-forge.gosilex.com}}}"
SHLINK_DOMAIN="${_ENV_SHLINK_DOMAIN:-${FORGE_SHLINK_DOMAIN:-${SHLINK_DOMAIN:-s.gosilex.com}}}"
ARTIFACTS_ROOT="${FORGE_ARTIFACTS_ROOT:-}"
INTERNAL_PREFIX="${FORGE_INTERNAL_PREFIX:-a}"
# Export PUBLIC_HOST for forge.env override after load_config
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
PUBLISH_LOCK_FD=""
PUBLISH_LOCK_DIR=""
cleanup() {
  if [ -n "${PUBLISH_LOCK_FD:-}" ]; then
    if command -v flock >/dev/null 2>&1; then
      flock -u "$PUBLISH_LOCK_FD" 2>/dev/null || true
    fi
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
  if PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'from load_config import doctor; import sys; sys.exit(0 if doctor()["ok"] else 1)' 2>/dev/null; then
    return 0
  fi
  warn "forge config incomplete — run skill forge-setup"
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "hub/artifacts not configured. Run forge-setup (doctor KO)."
}

usage() {
  cat <<EOF
Usage:
  publish.sh <slug> [path] [--share] [--title T] [--type TYPE] [--desc D]
  publish.sh --share <slug>
  publish.sh --unshare <slug>
  publish.sh --list | --remove <slug> | --rebuild-index

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

clone_engine() {
  WORK="$(mktemp -d)"
  info "clone engine $FORGE_REPO (main)"
  GIT clone --depth 1 --branch main --quiet "$FORGE_REPO" "$WORK/repo" \
    || die "clone impossible — branche main ? accès GitHub ?"
  [ -d "$WORK/repo/site" ] || die "repo sans site/ skeleton"
  [ -f "$WORK/repo/site/404.html" ] || die "site/404.html missing"
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
  [ -f "$build_py" ] || die "build-site-from-hub.py missing"
  info "build site from hub SSOT → $WORK/repo"
  PYTHONPATH="$(dirname "$build_py")/lib${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$build_py" --repo-root "$WORK/repo" \
    || die "build-site-from-hub failed"
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
    *) warn "forge.env mode $mode — chmod 600 recommandé" ;;
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
    case "$key" in
      CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|FORGE_SHARES_KV_ID|CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|SHLINK_API_URL|PUBLIC_HOST|FORGE_PAGES_PROJECT|SHLINK_DOMAIN)
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
  python3 -c 'import json,sys; d=json.load(sys.stdin); [print("✗", e, file=sys.stderr) for e in d.get("errors",[])]' <<<"$pf_json"
  die "Cloudflare preflight failed — fix forge.env / credentials before mutating"
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
  if command -v flock >/dev/null 2>&1; then
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

# Patch cloned wrangler.toml: KV id + plain [vars] from forge.env (+ API fallback)
patch_wrangler_for_deploy() {
  local toml="$1"
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
    "PUBLIC_HOST missing — set in forge.config.json or ~/.config/silex/forge.env"
  [ -f "$toml" ] || die "wrangler.toml missing: $toml"
  # --fetch-remote: preserve all Pages plain_text vars; local managed vars override.
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$LIB_DIR/patch_wrangler.py" --fetch-remote "$toml" "$kv" "$team" "$aud" "$host" "${shlink_url:-}"
}

# Direct Upload — HTML never touches git
deploy_pages() {
  preflight_cf_mutations
  source_cf_credentials
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die \
    "CLOUDFLARE_API_TOKEN missing — forge-setup (~/.config/silex/forge.env, chmod 600)"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$acct" ] || die \
    "CLOUDFLARE_ACCOUNT_ID missing — set in ~/.config/silex/forge.env (see .env.example)"
  local project="${FORGE_PAGES_PROJECT:-silex-forge}"
  export CLOUDFLARE_ACCOUNT_ID="$acct"
  cd "$WORK/repo"
  [ -d site ] || die "site/ missing in engine clone"
  [ -f wrangler.toml ] || die "wrangler.toml missing"
  patch_wrangler_for_deploy "$WORK/repo/wrangler.toml"
  info "wrangler pages deploy site → ${project} (${acct:0:8}…)"
  local wr_cmd
  wr_cmd=$(forge_wrangler) || die "wrangler / npx missing"
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
  [ -e "$input" ] || die "source introuvable: $input"
  if [ -f "$input" ]; then
    case "$input" in *.html|*.htm) ;; *) die "fichier .html attendu" ;; esac
    STAGE="$WORK/src"
    mkdir -p "$STAGE"
    cp -f "$input" "$STAGE/index.html"
    SRC_DIR="$STAGE"
  elif [ -d "$input" ]; then
    [ -f "$input/index.html" ] || die "dossier sans index.html"
    SRC_DIR="$input"
  else
    die "source invalide"
  fi
}

write_source_to_hub() {
  local slug="$1"
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "ARTIFACTS_ROOT vide"
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
    if (cd "$WORK/repo" && bash "$sh" "${args[@]}"); then
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
    "${img_args[@]}" \
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
  if python3 "$(SCRIPTS)/hub-index.py" "${hub_args[@]}"; then
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
  curl -sS -w '\n%{http_code}' -X "$method" "$url" "${auth[@]}" "$@"
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
  kv_set_visibility "$slug" "private" || return 1
  kv_delete_share "$slug" || return 1
}

# Fail-closed clear for slug removal/reuse:
#   1) delete share key (link stops working)
#   2) set vis:private tombstone (kept intentionally — NOT deleted)
kv_clear_artifact_auth() {
  local slug="$1"
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
  info "KV cleared for $slug (share + vis)"
  rm -rf "${ARTIFACTS_ROOT:?}/${slug}"
  ok "removed from hub SSOT: $slug"
  clone_engine
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
    info "KV share:${slug} revoked + vis:private"
  else
    die "KV revoke failed — share link may still work; fix credentials and retry"
  fi
  set_hub_shared "$slug" false
  clone_engine
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
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  clone_engine
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
    ok "index régénéré + live Pages"
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
      --public) die "--public et /p/ purgés. Utilise --share." ;;
      --title)  title="${2-}"; shift 2 ;;
      --type)   typ="${2-}"; shift 2 ;;
      --desc)   desc="${2-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "option inconnue: $1" ;;
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
      die "path missing and no ${ARTIFACTS_ROOT:-<artifacts>}/${slug}/index.html"
    fi
  fi

  WORK="$(mktemp -d)"
  resolve_source "$source"
  write_source_to_hub "$slug"

  local day
  day="$(date -u +%Y-%m-%d)"
  export SLUG="$slug" TITLE="$title" TYP="$typ" DESC="$desc" DAY="$day"
  export INTERNAL_PREFIX="$INTERNAL_PREFIX"
  export SHARED=""   # preserve existing meta.shared
  export OUT="${ARTIFACTS_ROOT}/${slug}/meta.json"
  write_hub_meta

  # clone engine + build full site from hub
  # (re-clone into same WORK: move src aside)
  local src_keep="$WORK/src-keep"
  mkdir -p "$src_keep"
  # WORK reused: clone_engine overwrites WORK assignment — fix by not resetting WORK
  local saved_work="$WORK"
  # clone into subdir without wiping WORK
  info "clone engine $FORGE_REPO (main)"
  GIT clone --depth 1 --branch main --quiet "$FORGE_REPO" "$saved_work/repo" \
    || die "clone impossible"
  WORK="$saved_work"
  [ -f "$WORK/repo/site/404.html" ] || die "site/404.html missing"

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
      die "usage: --share <slug>   ou   publish.sh <slug> [path] --share"
    fi
    ;;
  *)
    [ -n "${1-}" ] || { usage; exit 1; }
    cmd_publish "$@"
    ;;
esac
