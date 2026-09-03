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

# Mac: bash 3.2 cannot do `exec {var}>`; flock is Linux-only
assert_not_grep \
  'exec \{PUBLISH_LOCK_FD\}>' \
  "$PUBLISH" \
  "publish lock must not use bash 4.1 automatic FD allocation"

assert_grep \
  'exec 9>' \
  "$PUBLISH" \
  "publish lock must use a fixed FD (bash 3.2)"

assert_grep \
  'command -v flock' \
  "$PUBLISH" \
  "publish lock must probe flock rather than requiring it"

assert_grep \
  'PUBLISH_LOCK_DIR="\$candidate"' \
  "$PUBLISH" \
  "mkdir lock global must be set only after successful mkdir"

assert_grep \
  '\$\{lock_dir\}/\$\{slug\}\.lockdir' \
  "$PUBLISH" \
  "mkdir lock path must be slug.lockdir, not the flock slug.lock file"

assert_grep \
  'FORGE_PUBLISH_LIB_ONLY' \
  "$PUBLISH" \
  "publish.sh must be sourceable as a library without running the CLI"

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

assert_grep \
  'forge_common\.sh' \
  "$PUBLISH" \
  "publish.sh must source lib/forge_common.sh"

COMMON="$LIB/forge_common.sh"
[ -f "$COMMON" ] || fail "missing $COMMON"

side_dir=$(mktemp -d)
(
  cd "$side_dir" || exit 1
  # shellcheck source=/dev/null
  . "$COMMON"
  [ "$(pwd)" = "$side_dir" ] || exit 2
) >"$side_dir/stdout" 2>"$side_dir/stderr" || fail "sourcing forge_common.sh failed (status $?)"
[ ! -s "$side_dir/stdout" ] || fail "sourcing forge_common.sh wrote stdout"
[ ! -s "$side_dir/stderr" ] || fail "sourcing forge_common.sh wrote stderr"
pass "forge_common.sh sources with no output or cwd change"

empty_bin=$(mktemp -d)
if (
  # shellcheck source=/dev/null
  . "$COMMON"
  PATH="$empty_bin"
  export PATH
  forge_wrangler
) >"$side_dir/wrout" 2>"$side_dir/wrerr"; then
  fail "forge_wrangler must fail when wrangler and npx are missing"
fi
[ ! -s "$side_dir/wrout" ] || fail "forge_wrangler printed a command despite missing binaries"
pass "forge_wrangler fails closed without wrangler or npx"

fake_bin=$(mktemp -d)
printf '#!/bin/sh\n' >"$fake_bin/wrangler"
chmod +x "$fake_bin/wrangler"
got=$(
  # shellcheck source=/dev/null
  . "$COMMON"
  PATH="$fake_bin"
  export PATH
  forge_wrangler
) || fail "forge_wrangler should succeed when wrangler is on PATH"
[ "$got" = wrangler ] || fail "forge_wrangler printed '$got', expected wrangler"
pass "forge_wrangler prints wrangler when it is on PATH"

printf '#!/bin/sh\n' >"$fake_bin/npx"
chmod +x "$fake_bin/npx"
rm -f "$fake_bin/wrangler"
got=$(
  # shellcheck source=/dev/null
  . "$COMMON"
  PATH="$fake_bin"
  export PATH
  forge_wrangler
) || fail "forge_wrangler should succeed when npx is on PATH"
[ "$got" = "npx --yes wrangler" ] || fail "forge_wrangler printed '$got', expected npx --yes wrangler"
pass "forge_wrangler falls back to npx --yes wrangler"

rm -rf "$side_dir" "$empty_bin" "$fake_bin"

echo "all shell contract checks passed"
