#!/usr/bin/env bash
# Contract tests for publish.sh hardening — read-only against the script text and
# isolated fixtures (does not mutate publish.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLISH="$ROOT/plugins/silex-forge/scripts/publish.sh"
LIB="$ROOT/plugins/silex-forge/scripts/lib"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

assert_grep() {
  local pattern="$1" file="$2" msg="$3"
  grep -Eq "$pattern" "$file" || fail "$msg"
}

assert_not_grep() {
  local pattern="$1" file="$2" msg="$3"
  if grep -Eq "$pattern" "$file"; then
    fail "$msg"
  fi
}

echo "publish.sh contract tests"

# kv_wrangler OAuth fallback must strip REST credentials from env
assert_grep \
  'env -u CLOUDFLARE_API_TOKEN' \
  "$PUBLISH" \
  "kv_wrangler must unset CLOUDFLARE_API_TOKEN before wrangler OAuth"

assert_grep \
  'env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL' \
  "$PUBLISH" \
  "kv_wrangler must unset CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL for OAuth fallback"

# fetch_pages_plain_var delegates to Python (no shell curl pipe / heredoc)
assert_grep \
  'from load_config import.*fetch_pages_plain_var' \
  "$PUBLISH" \
  "fetch_pages_plain_var must delegate to load_config.fetch_pages_plain_var"

assert_not_grep \
  'curl.*[|].*python3.*<<'\''PY'\''' \
  "$PUBLISH" \
  "fetch_pages_plain_var must not pipe curl into python while heredoc consumes stdin"

assert_grep \
  'patch_wrangler\.py.*--fetch-remote|--fetch-remote.*patch_wrangler\.py' \
  "$PUBLISH" \
  "patch_wrangler_for_deploy must fetch remote Pages vars via patch_wrangler.py --fetch-remote"

assert_grep \
  'fetch_pages_plain_vars' \
  "$LIB/patch_wrangler.py" \
  "patch_wrangler must delegate remote var fetch to load_config.fetch_pages_plain_vars"

assert_grep \
  'cmd_remove|kv_clear_artifact_auth' \
  "$PUBLISH" \
  "publish.sh defines remove + kv clear helpers"

assert_grep \
  'vis:private|kv_set_visibility.*private' \
  "$PUBLISH" \
  "remove path must tombstone vis:private before destructive KV delete"

# Isolated fixture: OAuth env cleanup (reference impl mirrors publish.sh contract)
fixture="$ROOT/tests/shell/fixtures/kv_wrangler_env.sh"
mock_wrangler="$(mktemp)"
cat > "$mock_wrangler" <<'EOS'
#!/usr/bin/env bash
printf 'WRANGLER_ENV:'
env | grep -E '^CLOUDFLARE_' | sort | tr '\n' ';'
EOS
chmod +x "$mock_wrangler"
# shellcheck source=/dev/null
source "$fixture"
export CLOUDFLARE_API_TOKEN=secret-token CLOUDFLARE_API_KEY=legacy-key CLOUDFLARE_EMAIL=u@example.com
out="$(kv_wrangler_dry "$mock_wrangler" kv key put vis:demo private)"
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
[[ "$out" != *"CLOUDFLARE_API_TOKEN="* ]] || fail "dry-run kv_wrangler leaked API token to wrangler env"
[[ "$out" != *"CLOUDFLARE_API_KEY="* ]] || fail "dry-run kv_wrangler leaked API key to wrangler env"
[[ "$out" != *"CLOUDFLARE_EMAIL="* ]] || fail "dry-run kv_wrangler leaked API email to wrangler env"
rm -f "$mock_wrangler"
pass "kv_wrangler dry-run strips REST credentials"

# load_config.fetch_pages_plain_var is importable from publish lib path
PYTHONPATH="$LIB" python3 -c 'from load_config import fetch_pages_plain_var; assert callable(fetch_pages_plain_var)'
pass "load_config.fetch_pages_plain_var importable from publish lib path"

echo "all shell contract checks passed"
