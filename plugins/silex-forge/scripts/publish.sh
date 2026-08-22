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

die()  { echo "✗ $*" >&2; exit 1; }
info() { echo "▸ $*"; }
warn() { echo "  ⚠ $*" >&2; }
ok()   { echo "✓ $*"; }

GIT() { git -c core.hooksPath=/dev/null "$@"; }

WORK=""
cleanup() { [ -n "${WORK:-}" ] && rm -rf "$WORK"; }
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
    */*|*..*|.|.. ) die "invalid slug (path): '$s'" ;;
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
source_cf_credentials() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  local mode
  mode=$(stat -c '%a' "$f" 2>/dev/null || stat -f '%OLp' "$f" 2>/dev/null || echo "")
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

# Fetch a plain Pages production var (preserve SHLINK_API_URL when absent locally)
fetch_pages_plain_var() {
  local name="$1"
  source_cf_credentials
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local project="${FORGE_PAGES_PROJECT:-silex-forge}"
  [ -n "$acct" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || return 1
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${acct}/pages/projects/${project}" \
    | python3 - "$name" <<'PY'
import json, sys
name = sys.argv[1]
try:
    d = json.load(sys.stdin)
    ev = (d.get("result") or {}).get("deployment_configs", {}).get("production", {}).get("env_vars") or {}
    v = ev.get(name) or {}
    if v.get("type") == "plain_text" and v.get("value"):
        print(v["value"])
except Exception:
    pass
PY
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
  if [ -z "$shlink_url" ]; then
    shlink_url="$(fetch_pages_plain_var SHLINK_API_URL 2>/dev/null || true)"
  fi
  [ -f "$toml" ] || die "wrangler.toml missing: $toml"
  python3 "$LIB_DIR/patch_wrangler.py" "$toml" "$kv" "$team" "$aud" "$host" "$shlink_url"
}

# Direct Upload — HTML never touches git
deploy_pages() {
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
  local -a wr
  if command -v wrangler >/dev/null 2>&1; then
    wr=(wrangler)
  elif command -v npx >/dev/null 2>&1; then
    wr=(npx --yes wrangler)
  else
    die "wrangler / npx missing"
  fi
  "${wr[@]}" pages deploy site \
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
    (cd "$WORK/repo" && bash "$sh" "${args[@]}") \
      && ok "og thumbs" || warn "gen-og-images skip/failed (publish continues)"
  fi
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
    [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" ] \
      && cp -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" "${ARTIFACTS_ROOT}/${slug}/og.jpg" || true
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

kv_curl() {
  local method="$1" path="$2"
  shift 2
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local ns="${FORGE_SHARES_KV_ID:-}"
  [ -n "$acct" ] || die "CLOUDFLARE_ACCOUNT_ID missing for KV"
  [ -n "$ns" ] || die "FORGE_SHARES_KV_ID missing for KV"
  local url="https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}${path}"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    curl -sS -X "$method" "$url" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$@"
  else
    curl -sS -X "$method" "$url" \
      -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" "$@"
  fi
}

wrangler_bin() {
  if command -v wrangler >/dev/null 2>&1; then
    printf '%s\n' wrangler
  elif command -v npx >/dev/null 2>&1; then
    printf '%s\n' 'npx --yes wrangler'
  else
    return 1
  fi
}

# Pages deploy tokens often lack KV API scope; wrangler OAuth may still work.
kv_wrangler() {
  local wb ns="${FORGE_SHARES_KV_ID:-}"
  [ -n "$ns" ] || return 1
  wb=$(wrangler_bin) || return 1
  # shellcheck disable=SC2086
  env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
    $wb "$@" --remote --namespace-id="$ns"
}

kv_put_value() {
  local key="$1" val="$2"
  if kv_auth_ok; then
    if kv_curl PUT "/values/${key}" -H "Content-Type: text/plain" --data "$val" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)'; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  kv_wrangler kv key put "$key" "$val" >/dev/null 2>&1
}

kv_delete_key() {
  local key="$1"
  if kv_auth_ok; then
    if kv_curl DELETE "/values/${key}" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)'; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  kv_wrangler kv key delete "$key" >/dev/null 2>&1
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
  kv_set_visibility "$slug" "shared" || return 1
}

kv_revoke_share() {
  local slug="$1"
  kv_delete_share "$slug" || return 1
  kv_set_visibility "$slug" "private" || return 1
}

kv_clear_artifact_auth() {
  local slug="$1"
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -n "${FORGE_SHARES_KV_ID:-}" ] || return 1
  kv_delete_key "share:${slug}" || true
  kv_delete_key "vis:${slug}" || true
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
  if shlink short -- "$long_url" "$short_slug" 2>/dev/null; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}"
    return 0
  fi
  local r
  r=$(python3 -c "import secrets; print(secrets.token_hex(2))")
  if shlink short -- "$long_url" "${short_slug}-${r}" 2>/dev/null; then
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
    info "KV share:${slug} + vis:shared OK"
  else
    die "KV share activation failed — set CLOUDFLARE_API_TOKEN with Workers KV Edit, or wrangler login (OAuth)"
  fi
  set_hub_shared "$slug" true
  short_url=""
  if su=$(maybe_shortlink "$share_url" "$slug"); then
    short_url="$su"
  fi
  if [ -n "$short_url" ]; then
    echo "$short_url"
  else
    echo "$share_url"
  fi
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
  source_cf_credentials
  if kv_clear_artifact_auth "$slug"; then
    info "KV cleared for $slug (share + vis)"
  else
    warn "KV clear failed for $slug — old share/vis may survive slug reuse"
  fi
  rm -rf "${ARTIFACTS_ROOT}/${slug}"
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
  source_cf_credentials
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
    [ -n "${ARTIFACTS_ROOT:-}" ] && cp -f "$html" "${ARTIFACTS_ROOT}/${slug}/index.html" || true
  fi
  deploy_pages || die "deploy failed after unshare"
  ok "share revoked for $slug"
}

cmd_share_only() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  local url
  url=$(create_share_kv "$slug")
  clone_engine
  build_from_hub
  local html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  if [ -f "$html" ]; then
    python3 "$(SCRIPTS)/inject-share-bar.py" "$html" --slug "$slug" || true
    cp -f "$html" "${ARTIFACTS_ROOT}/${slug}/index.html" || true
  fi
  if deploy_pages; then
    ok "share mint"
    echo "  URL:   $url"
    hub_index_update "$slug"
  fi
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
  clone_engine
  build_from_hub
  gen_og_images
  # rebuild again to pick og files into hub? og written to site then copy back
  if [ -n "${ARTIFACTS_ROOT:-}" ]; then
    local s
    for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
      [ -d "$s" ] || continue
      local slug
      slug=$(basename "$s")
      [ -f "${s}og.jpg" ] && cp -f "${s}og.jpg" "${ARTIFACTS_ROOT}/${slug}/og.jpg" || true
    done
  fi
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

  export SLUG="$slug" TITLE="$title" TYP="$typ" DESC="$desc" DAY="$(date -u +%Y-%m-%d)"
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
  inject_og_for_slug "$slug" "$title" "$desc" "$path_url"
  python3 "$(SCRIPTS)/inject-share-bar.py" "$dest/index.html" --slug "$slug" || true
  # persist bar into hub
  cp -f "$dest/index.html" "${ARTIFACTS_ROOT}/${slug}/index.html" || true
  # rebuild registry/index after og inject (og.jpg may be new)
  build_from_hub

  local share_url=""
  if $do_share; then
    share_url=$(create_share_kv "$slug")
    build_from_hub
    python3 "$(SCRIPTS)/inject-share-bar.py" \
      "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html" --slug "$slug" || true
  fi

  if deploy_pages; then
    ok "published (hub SSOT + wrangler Pages)"
    echo "  Team: https://${PUBLIC_HOST}${path_url}  (Access)"
    if [ -n "$share_url" ]; then
      echo "  Share:   $share_url  (public, unlisted)"
    fi
    hub_index_update "$slug"
  fi
}

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
