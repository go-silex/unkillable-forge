#!/usr/bin/env bash
# Exercise release recovery without contacting GitHub.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-env-guard.sh"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASH_BIN="${FORGE_BASH:-bash}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP" TEST_STATE="$TMP/state" TEST_LOG="$TMP/gh.log"
mkdir -p "$TMP/repo/scripts" "$TMP/repo/docs" "$TMP/bin" "$TMP/out"
cp "$ROOT/scripts/release-engine.sh" "$ROOT/scripts/check_plugin_versions.py" "$TMP/repo/scripts/"
cp "$ROOT/engine.json" "$TMP/repo/"
cp "$ROOT/docs/engine-changelog.md" "$TMP/repo/docs/"
VERSION="$(python3 "$TMP/repo/scripts/check_plugin_versions.py" --print-engine-version)"
export VERSION
for f in "forge-engine-${VERSION}.tar.gz" release.json SHA256SUMS; do : >"$TMP/out/$f"; done
cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$TEST_LOG"
case "$1 $2" in
  'release view')
    [ "$(cat "$TEST_STATE")" != absent ] || exit 1
    if [ "${4:-}" = --json ]; then
      python3 - "$TEST_STATE" "$VERSION" <<'PY'
import json, sys
state = open(sys.argv[1]).read().strip()
assets = [{'name': n, 'state': 'uploaded'} for n in ('forge-engine-' + sys.argv[2] + '.tar.gz', 'release.json', 'SHA256SUMS')]
if state == 'missing': assets.pop()
if state in ('pending', 'stuck'): assets[-1]['state'] = 'starter'
print(json.dumps({'isDraft': state == 'draft', 'assets': assets}))
PY
    fi ;;
  'release upload')
    [ "$(cat "$TEST_STATE")" = stuck ] || echo draft >"$TEST_STATE" ;;
  'release edit') echo published >"$TEST_STATE" ;;
  'release create') echo published >"$TEST_STATE" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
git -C "$TMP/repo" init -b main >/dev/null 2>&1
git -C "$TMP/repo" config user.email test@example.com
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config commit.gpgsign false
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -m fixture >/dev/null 2>&1
git -C "$TMP/repo" tag "engine/v$VERSION"
git -C "$TMP/repo" remote add origin "$TMP/repo"
check_status() {
  local expected="$1" rc=0
  "$BASH_BIN" "$TMP/repo/scripts/release-engine.sh" check >"$TMP/check.log" 2>&1 || rc=$?
  [ "$rc" -eq "$expected" ] || { cat "$TMP/check.log" >&2; echo "expected $expected, got $rc" >&2; exit 1; }
}
for state in draft missing pending absent; do
  echo "$state" >"$TEST_STATE"
  check_status 0
done
echo published >"$TEST_STATE"
check_status 78
for state in draft missing pending; do
  echo "$state" >"$TEST_STATE"
  : >"$TEST_LOG"
  "$BASH_BIN" "$TMP/repo/scripts/release-engine.sh" publish "$TMP/out" >/dev/null
  grep -q '^release upload ' "$TEST_LOG"
  grep -q '^release edit .*--draft=false' "$TEST_LOG"
  check_status 78
done
echo stuck >"$TEST_STATE"
: >"$TEST_LOG"
if "$BASH_BIN" "$TMP/repo/scripts/release-engine.sh" publish "$TMP/out" >/dev/null 2>&1; then
  echo 'incomplete upload unexpectedly published' >&2; exit 1
fi
if grep -q '^release edit ' "$TEST_LOG"; then
  echo 'published before assets were ready' >&2; exit 1
fi
echo 'test_release_engine: all good'
