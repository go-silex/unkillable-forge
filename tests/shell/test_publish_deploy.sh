#!/usr/bin/env bash
# Behavioral tests for deploy_pages — the function that decides WHERE production
# HTML lands. wrangler is a stub on PATH that records its argv, its cwd and the
# Cloudflare env it was handed, so every assertion is on observable deploy
# behaviour rather than on the script text.
#
# Isolation: FORGE_CONFIG + FORGE_ENV/FORGE_ENV_FILE point into mktemp -d, the
# Cloudflare boundaries (preflight, credential sourcing, wrangler.toml patch) are
# redefined after the lib-only source. No network, no real hub, no
# ~/.config/silex read, no write outside the temp dir.
# bash 3.2-safe (no mapfile, no declare -A, no ${x^^}).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# FORGE_PUBLISH_SH lets a falsification run point this suite at a scratch copy of
# publish.sh (its lib/ must sit next to it). Unset = the real script.
PUBLISH="${FORGE_PUBLISH_SH:-$ROOT/plugins/silex-forge/scripts/publish.sh}"
[ -f "$PUBLISH" ] || { echo "  FAIL publish.sh not found: $PUBLISH" >&2; exit 1; }

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }
note() { echo "      $*"; }

echo "deploy_pages tests ($PUBLISH)"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

PROJECT="forge-test-project"
ACCOUNT="acc0123456789beefcafe"
TOKEN="test-token-not-a-real-secret"

mkdir -p "$TD/hub/artifacts"
cat > "$TD/cfg.json" <<EOF
{"version": 1, "hub_root": "$TD/hub", "artifacts_dir": "artifacts",
 "site_dir": "site", "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.example.com", "pages_project": "$PROJECT",
 "forge_repo": "$TD/engine"}
EOF
export FORGE_CONFIG="$TD/cfg.json"
# The shell reads FORGE_ENV_FILE, load_config.py reads FORGE_ENV. Both must be
# temp paths or the operator's real forge.env would leak into the test.
export FORGE_ENV="$TD/forge.env"
export FORGE_ENV_FILE="$TD/forge.env"

# --- wrangler stub -----------------------------------------------------------
BIN="$TD/bin"
mkdir -p "$BIN"
cat > "$BIN/wrangler" <<'SH'
#!/bin/sh
{
  printf 'argv:'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\n'
  printf 'cwd: %s\n' "$PWD"
  printf 'account: %s\n' "${CLOUDFLARE_ACCOUNT_ID-}"
} >> "$WRANGLER_REC"
exit "${WRANGLER_EXIT:-0}"
SH
chmod +x "$BIN/wrangler"
export PATH="$BIN:$PATH"

# --- isolation guard ---------------------------------------------------------
# Every publish.sh source happens inside a subshell, on purpose: the flag, the
# stub redefinitions and WORK must not leak between cases. That pattern trips
# SC2030/SC2031 (subshell-local assignment), SC2034 (WORK is read by the sourced
# deploy_pages) and SC2317 (shellcheck cannot see past `.`).
# shellcheck disable=SC2030
iso=$(
  export FORGE_PUBLISH_LIB_ONLY=1
  # shellcheck source=/dev/null
  . "$PUBLISH" >/dev/null 2>&1
  printf '%s\n%s\n' "${FORGE_ENV_FILE:-}" "${ARTIFACTS_ROOT:-}"
)
iso_env=$(printf '%s' "$iso" | sed -n '1p')
iso_art=$(printf '%s' "$iso" | sed -n '2p')
[ "$iso_env" = "$TD/forge.env" ] \
  || fail "forge.env not isolated (would read the operator's credentials): $iso_env"
case "$iso_art" in
  "$HOME"/*|"") fail "ARTIFACTS_ROOT not isolated (real hub): $iso_art" ;;
esac
case "$iso_art" in
  */artifacts) ;;
  *) fail "ARTIFACTS_ROOT did not come from the temp config: $iso_art" ;;
esac
pass "config and forge.env resolve into the temp dir (real ~/.config/silex untouched)"

# --- fixtures ----------------------------------------------------------------
mk_engine() {
  local w="$1"
  mkdir -p "$w/repo/site/a/demo" "$w/repo/site/a/other"
  printf '<html>root</html>\n' > "$w/repo/site/index.html"
  printf '<html>demo</html>\n' > "$w/repo/site/a/demo/index.html"
  printf '<html>other</html>\n' > "$w/repo/site/a/other/index.html"
  printf 'name = "%s"\n' "$PROJECT" > "$w/repo/wrangler.toml"
}

CASE_N=0
new_case() {
  CASE_N=$((CASE_N + 1))
  CASE_DIR="$TD/case$CASE_N"
  REC="$CASE_DIR/wrangler.rec"
  LOG="$CASE_DIR/deploy.log"
  mkdir -p "$CASE_DIR"
  : > "$REC"
  : > "$LOG"
  CASE_TOKEN="$TOKEN"
  CASE_ACCOUNT="$ACCOUNT"
  CASE_WEXIT=0
  CASE_HIJACK=""
  mk_engine "$CASE_DIR/work"
}

# deploy_pages in an isolated subshell: it cd's and exports, and publish.sh
# installs an EXIT trap that wipes WORK.
# shellcheck disable=SC2031,SC2034,SC2317
run_deploy() {
  (
    export FORGE_PUBLISH_LIB_ONLY=1
    export WRANGLER_REC="$REC"
    export WRANGLER_EXIT="$CASE_WEXIT"
    # shellcheck source=/dev/null
    . "$PUBLISH"
    # Boundaries this file does not own: preflight_cf_mutations and
    # source_cf_credentials reach the Cloudflare API / the operator's forge.env,
    # patch_wrangler_for_deploy fetches remote Pages vars and is covered by
    # tests/python/test_patch_wrangler.py. Only the record matters here.
    preflight_cf_mutations() { :; }
    source_cf_credentials() { :; }
    patch_wrangler_for_deploy() { echo "patched: $1" >> "$WRANGLER_REC"; }
    export CLOUDFLARE_API_TOKEN="$CASE_TOKEN"
    export CLOUDFLARE_ACCOUNT_ID="$CASE_ACCOUNT"
    # A stale forge.env exports FORGE_PAGES_PROJECT long after startup.
    if [ -n "$CASE_HIJACK" ]; then export FORGE_PAGES_PROJECT="$CASE_HIJACK"; fi
    WORK="$CASE_DIR/work"
    deploy_pages
  ) > "$LOG" 2>&1
}

dump() { echo "--- record ---" >&2; cat "$REC" >&2; echo "--- log ---" >&2; cat "$LOG" >&2; }
must_rec() { grep -Fq -- "$1" "$REC" || { dump; fail "$2"; }; }
must_not_rec() { if grep -Fq -- "$1" "$REC"; then dump; fail "$2"; fi; }
no_wrangler() {
  if grep -q '^argv:' "$REC"; then dump; fail "$1"; fi
}
wrangler_calls() { grep -c '^argv:' "$REC" || true; }

# --- 1. project comes from the config, argv, cwd, account --------------------
new_case
run_deploy || { dump; fail "deploy_pages failed on a valid engine tree"; }

[ "$(wrangler_calls)" = "1" ] \
  || { dump; fail "expected exactly one wrangler invocation, got $(wrangler_calls)"; }
ARGV_LINE=$(sed -n 's/^argv: //p' "$REC")
note "recorded argv → $ARGV_LINE"

must_rec "--project-name=$PROJECT" \
  "deploy did not target the config's Pages project ($PROJECT)"
pass "deploy targets the Pages project from forge.config.json"

must_rec "argv: pages deploy site " "wrangler was not called as 'pages deploy site'"
must_rec "--branch=main" "deploy did not pin --branch=main (production branch)"
must_rec "--commit-dirty=true" "deploy did not pass --commit-dirty=true"
pass "argv: pages deploy site --branch=main --commit-dirty=true"

must_rec "cwd: $CASE_DIR/work/repo" \
  "wrangler ran outside the engine clone — 'site' would resolve to another tree"
pass "wrangler runs from \$WORK/repo (site/ resolves to the engine clone)"

must_rec "account: $ACCOUNT" \
  "CLOUDFLARE_ACCOUNT_ID was not exported into the wrangler environment"
pass "CLOUDFLARE_ACCOUNT_ID reaches the wrangler environment"

case "$(sed -n '1p' "$REC")" in
  patched:*) ;;
  *) dump; fail "wrangler.toml was not patched before the deploy" ;;
esac
pass "wrangler.toml is patched before wrangler runs"

# --- 2. a stale FORGE_PAGES_PROJECT cannot redirect the deploy ---------------
new_case
CASE_HIJACK="hijacked-project"
run_deploy || { dump; fail "deploy_pages failed with FORGE_PAGES_PROJECT set"; }

must_rec "--project-name=$PROJECT" \
  "FORGE_PAGES_PROJECT set after startup redirected the deploy — the project must stay frozen from the config"
must_not_rec "hijacked-project" \
  "deploy landed in the project from the environment instead of the config"
pass "FORGE_PAGES_PROJECT in the environment cannot redirect the deploy"

# --- 3. fails closed on an empty CLOUDFLARE_API_TOKEN ------------------------
new_case
CASE_TOKEN=""
if run_deploy; then dump; fail "empty CLOUDFLARE_API_TOKEN must abort the deploy"; fi
no_wrangler "wrangler ran with an empty token — it would fall back to its own OAuth session"
pass "empty CLOUDFLARE_API_TOKEN fails closed, wrangler never runs"

# --- 4. fails closed on an empty CLOUDFLARE_ACCOUNT_ID -----------------------
new_case
CASE_ACCOUNT=""
if run_deploy; then dump; fail "empty CLOUDFLARE_ACCOUNT_ID must abort the deploy"; fi
no_wrangler "wrangler ran without an account id"
pass "empty CLOUDFLARE_ACCOUNT_ID fails closed, wrangler never runs"

# --- 5. fails closed when the tree to deploy is missing ----------------------
new_case
rm -rf "$CASE_DIR/work/repo/site"
if run_deploy; then dump; fail "missing site/ must abort the deploy"; fi
no_wrangler "wrangler ran without site/ in the engine clone"
pass "missing site/ fails closed, wrangler never runs"

new_case
rm -f "$CASE_DIR/work/repo/wrangler.toml"
if run_deploy; then dump; fail "missing wrangler.toml must abort the deploy"; fi
no_wrangler "wrangler ran without wrangler.toml"
pass "missing wrangler.toml fails closed, wrangler never runs"

# --- 6. a failing wrangler is a failure --------------------------------------
new_case
CASE_WEXIT=1
if run_deploy; then
  dump
  fail "a non-zero wrangler must make deploy_pages fail — callers mint a share key on success"
fi
must_rec "--project-name=$PROJECT" "wrangler was never reached in the failing-deploy case"
pass "a failing wrangler propagates as a deploy_pages failure"

echo "all deploy_pages checks passed"
