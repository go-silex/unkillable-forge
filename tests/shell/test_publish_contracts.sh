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

assert_not_grep \
  'git@github.com:go-silex/silex-forge.git' \
  "$PUBLISH" \
  "publish.sh must not contain the legacy SSH default"

assert_grep \
  'https://github.com/go-silex/silex-forge.git' \
  "$PUBLISH" \
  "publish.sh default FORGE_REPO must be HTTPS"

assert_grep \
  'materialize_engine' \
  "$PUBLISH" \
  "publish.sh must define materialize_engine"

assert_grep \
  'GIT -C "\$FORGE_REPO" archive HEAD' \
  "$PUBLISH" \
  "materialize_engine must git archive HEAD from a local checkout"

assert_not_grep \
  'cp -R "\$FORGE_REPO/site"' \
  "$PUBLISH" \
  "materialize_engine must not cp -R site/"

cmd_publish_body=$(mktemp)
awk '
  /^cmd_publish\(\)/ {p=1}
  p {print}
  p && /^}/ {exit}
' "$PUBLISH" > "$cmd_publish_body"
[ -s "$cmd_publish_body" ] || fail "failed to extract cmd_publish body"
assert_not_grep \
  'GIT[[:space:]]+clone' \
  "$cmd_publish_body" \
  "cmd_publish must not contain a raw GIT clone"
rm -f "$cmd_publish_body"
pass "cmd_publish does not GIT clone"

command -v git >/dev/null 2>&1 \
  || fail "git required for materialize_engine archive tests (CI: apk add git)"

# Behavioral: local engine via git archive HEAD (real git, no stub)
engine=$(mktemp -d)
mkdir -p "$engine/site/a" "$engine/functions" "$engine/plugins/silex-forge/scripts"
printf '404\n' > "$engine/site/404.html"
printf 'generated\n' > "$engine/site/a/index.html"
printf 'name = "forge"\n' > "$engine/wrangler.toml"
printf 'export default {}\n' > "$engine/functions/hello.js"
printf '#!/bin/sh\n' > "$engine/plugins/silex-forge/scripts/x.sh"
git -C "$engine" init -q
git -C "$engine" config user.email "forge-test@example.com"
git -C "$engine" config user.name "Forge Test"
git -C "$engine" add \
  site/404.html wrangler.toml functions/hello.js \
  plugins/silex-forge/scripts/x.sh site/a/index.html
git -C "$engine" -c commit.gpgsign=false commit -q -m "engine"
printf 'dirty\n' > "$engine/site/dirty.html"

work=$(mktemp -d)
if ! (
  FORGE_PUBLISH_LIB_ONLY=1
  export FORGE_PUBLISH_LIB_ONLY
  # shellcheck source=/dev/null
  . "$PUBLISH"
  FORGE_REPO="$engine"
  WORK="$work"
  export FORGE_REPO WORK
  materialize_engine
  [ -f "$WORK/repo/site/404.html" ] || { echo "missing site/404.html" >&2; exit 1; }
  [ -f "$WORK/repo/wrangler.toml" ] || { echo "missing wrangler.toml" >&2; exit 1; }
  [ -f "$WORK/repo/functions/hello.js" ] || { echo "missing functions/hello.js" >&2; exit 1; }
  [ -f "$WORK/repo/plugins/silex-forge/scripts/x.sh" ] || { echo "missing plugins scripts" >&2; exit 1; }
  [ ! -e "$WORK/repo/site/a" ] || { echo "site/a should be absent after archive" >&2; exit 1; }
  [ ! -e "$WORK/repo/site/dirty.html" ] || { echo "untracked dirty.html must be absent" >&2; exit 1; }
  [ ! -e "$WORK/repo/.git" ] || { echo ".git must not be in dest" >&2; exit 1; }
  WORK=""
  trap - EXIT
); then
  fail "materialize_engine local git archive failed"
fi
pass "materialize_engine archives local git HEAD"

nongit=$(mktemp -d)
mkdir -p "$nongit/site"
printf '404\n' > "$nongit/site/404.html"
nongit_work=$(mktemp -d)
if (
  FORGE_PUBLISH_LIB_ONLY=1
  export FORGE_PUBLISH_LIB_ONLY
  # shellcheck source=/dev/null
  . "$PUBLISH"
  FORGE_REPO="$nongit"
  WORK="$nongit_work"
  export FORGE_REPO WORK
  materialize_engine
); then
  fail "materialize_engine must die when FORGE_REPO is not a git work tree"
fi
pass "materialize_engine fails closed without git metadata"

if (
  FORGE_PUBLISH_LIB_ONLY=1
  export FORGE_PUBLISH_LIB_ONLY
  # shellcheck source=/dev/null
  . "$PUBLISH"
  unset WORK
  materialize_engine
); then
  fail "materialize_engine must die when WORK is unset"
fi
pass "materialize_engine fails closed without WORK"

git_stub=$(mktemp -d)
printf '#!/bin/sh\necho "git invoked: $*" >&2\nexit 1\n' > "$git_stub/git"
chmod +x "$git_stub/git"

if (
  FORGE_PUBLISH_LIB_ONLY=1
  export FORGE_PUBLISH_LIB_ONLY
  # shellcheck source=/dev/null
  . "$PUBLISH"
  FORGE_REPO="https://github.com/go-silex/silex-forge.git"
  WORK="$(mktemp -d)"
  PATH="$git_stub:$PATH"
  export FORGE_REPO WORK PATH
  materialize_engine
); then
  fail "URL-like FORGE_REPO must not take the local-engine branch"
fi
pass "URL-like FORGE_REPO does not take local branch"

rm -rf "$engine" "$work" "$nongit" "$nongit_work" "$git_stub"

echo "all shell contract checks passed"
