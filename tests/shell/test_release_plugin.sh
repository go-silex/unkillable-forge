#!/usr/bin/env bash
# Behaviour tests for scripts/release-plugin.sh — isolated tmpdir, no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$TMP/empty.gitconfig"
export GIT_TERMINAL_PROMPT=0
touch "$TMP/empty.gitconfig"

GH_LOG="$TMP/gh.log"
: >"$GH_LOG"
export GH_LOG

mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
exit 0
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

gh_calls() {
  if [ -f "$GH_LOG" ]; then
    wc -l <"$GH_LOG" | tr -d ' '
  else
    echo 0
  fi
}

write_version_files() {
  local dest="$1"
  local plugin_json='{"name":"silex-forge","version":"9.9.9"}'
  mkdir -p \
    "$dest/scripts" \
    "$dest/plugins/silex-forge/.claude-plugin" \
    "$dest/plugins/silex-forge/.grok-plugin" \
    "$dest/plugins/silex-forge/.omp-plugin" \
    "$dest/plugins/silex-forge/.codex-plugin" \
    "$dest/.claude-plugin" \
    "$dest/.grok-plugin" \
    "$dest/.omp-plugin"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/plugin.json"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/.claude-plugin/plugin.json"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/.grok-plugin/plugin.json"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/.omp-plugin/plugin.json"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/.codex-plugin/plugin.json"
  printf '%s\n' "$plugin_json" >"$dest/plugins/silex-forge/package.json"
  cat >"$dest/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "silex-forge",
  "version": "9.9.9",
  "plugins": [
    {"name": "silex-forge", "version": "9.9.9", "source": "./plugins/silex-forge"}
  ]
}
EOF
  cat >"$dest/.grok-plugin/marketplace.json" <<'EOF'
{
  "name": "silex-forge",
  "version": "9.9.9",
  "plugins": [
    {"name": "silex-forge", "version": "9.9.9", "source": "./plugins/silex-forge"}
  ]
}
EOF
  cat >"$dest/.omp-plugin/marketplace.json" <<'EOF'
{
  "name": "silex-forge",
  "metadata": {"version": "9.9.9"},
  "plugins": [
    {"name": "silex-forge", "version": "9.9.9", "source": "./plugins/silex-forge"}
  ]
}
EOF
  cat >"$dest/CHANGELOG.md" <<'EOF'
# Changelog

## [9.9.9]

- Test notes for release 9.9.9.
EOF
}

setup_fixture() {
  local dest="$1"
  local bare="$2"
  git init --bare -b main "$bare" >/dev/null 2>&1
  write_version_files "$dest"
  cp "$ROOT/scripts/release-plugin.sh" "$dest/scripts/"
  cp "$ROOT/scripts/check_plugin_versions.py" "$dest/scripts/"
  chmod +x "$dest/scripts/release-plugin.sh"
  git -C "$dest" init -b main >/dev/null 2>&1
  git -C "$dest" config user.email "test@example.com"
  git -C "$dest" config user.name "test"
  git -C "$dest" config commit.gpgsign false
  git -C "$dest" config tag.gpgsign false
  git -C "$dest" add .
  git -C "$dest" commit -m "fixture" >/dev/null 2>&1
  git -C "$dest" remote add origin "$bare"
  git -C "$dest" push origin HEAD:main >/dev/null 2>&1
}

run_release() {
  local repo="$1"
  set +e
  out="$(cd "$repo" && ./scripts/release-plugin.sh 2>&1)"
  rc=$?
  set -e
}

tag_ref="refs/tags/silex-forge/v9.9.9"

# --- main fixture (cases 1–4) ---
FIXTURE="$TMP/repo"
BARE="$TMP/origin.git"
setup_fixture "$FIXTURE" "$BARE"

# CAS 1 (nominal)
run_release "$FIXTURE"
cas1=0
if [ "$rc" -ne 0 ]; then
  echo "FAIL nominal (exit $rc: $out)"
  cas1=1
fi
if ! git -C "$FIXTURE" rev-parse -q --verify "$tag_ref" >/dev/null; then
  echo "FAIL nominal (local tag missing)"
  cas1=1
fi
if git -C "$FIXTURE" rev-parse -q --verify "refs/tags/v9.9.9" >/dev/null; then
  echo "FAIL nominal (naked v9.9.9 tag must not be created)"
  cas1=1
fi
if ! git -C "$FIXTURE" ls-remote --tags origin | grep -F -q "refs/tags/silex-forge/v9.9.9"; then
  echo "FAIL nominal (remote tag missing)"
  cas1=1
fi
if [ "$(gh_calls)" != "1" ]; then
  echo "FAIL nominal (gh calls=$(gh_calls) want 1)"
  cas1=1
fi
if ! grep -q "release create silex-forge/v9.9.9" "$GH_LOG"; then
  echo "FAIL nominal (gh missing release create silex-forge/v9.9.9)"
  cas1=1
fi
if ! grep -q -- "--verify-tag" "$GH_LOG"; then
  echo "FAIL nominal (gh missing --verify-tag)"
  cas1=1
fi
if [ "$cas1" -eq 0 ]; then
  echo "OK   nominal"
else
  fail=1
fi
TAG_SHA="$(git -C "$FIXTURE" rev-list -n 1 "$tag_ref")"

# CAS 2 (idempotence)
run_release "$FIXTURE"
cas2=0
if [ "$rc" -ne 0 ]; then
  echo "FAIL idempotence (exit $rc: $out)"
  cas2=1
fi
if ! printf '%s\n' "$out" | grep -q "skip"; then
  echo "FAIL idempotence (no skip message: $out)"
  cas2=1
fi
if [ "$(gh_calls)" != "1" ]; then
  echo "FAIL idempotence (gh calls=$(gh_calls) want 1)"
  cas2=1
fi
got_sha="$(git -C "$FIXTURE" rev-list -n 1 "$tag_ref")"
if [ "$got_sha" != "$TAG_SHA" ]; then
  echo "FAIL idempotence (tag SHA moved)"
  cas2=1
fi
if [ "$cas2" -eq 0 ]; then
  echo "OK   idempotence"
else
  fail=1
fi

# CAS 3 (ancestor)
git -C "$FIXTURE" commit --allow-empty -m "after tag" >/dev/null
run_release "$FIXTURE"
cas3=0
if [ "$rc" -ne 0 ]; then
  echo "FAIL ancestor (exit $rc: $out)"
  cas3=1
fi
if ! printf '%s\n' "$out" | grep -q "skip"; then
  echo "FAIL ancestor (no skip message: $out)"
  cas3=1
fi
got_sha="$(git -C "$FIXTURE" rev-list -n 1 "$tag_ref")"
if [ "$got_sha" != "$TAG_SHA" ]; then
  echo "FAIL ancestor (tag SHA moved, want $TAG_SHA got $got_sha)"
  cas3=1
fi
if [ "$(gh_calls)" != "1" ]; then
  echo "FAIL ancestor (gh calls=$(gh_calls) want 1)"
  cas3=1
fi
if [ "$cas3" -eq 0 ]; then
  echo "OK   ancestor"
else
  fail=1
fi

# CAS 4 (refuse move)
git -C "$FIXTURE" checkout --orphan diverge >/dev/null 2>&1
git -C "$FIXTURE" commit --allow-empty -m "diverge" >/dev/null
run_release "$FIXTURE"
cas4=0
if [ "$rc" -eq 0 ]; then
  echo "FAIL refuse-move (exit 0, want non-zero: $out)"
  cas4=1
fi
got_sha="$(git -C "$FIXTURE" rev-list -n 1 "$tag_ref")"
if [ "$got_sha" != "$TAG_SHA" ]; then
  echo "FAIL refuse-move (tag SHA moved)"
  cas4=1
fi
if [ "$(gh_calls)" != "1" ]; then
  echo "FAIL refuse-move (gh calls=$(gh_calls) want 1)"
  cas4=1
fi
if [ "$cas4" -eq 0 ]; then
  echo "OK   refuse-move"
else
  fail=1
fi

# CAS 5 (fail-closed CHANGELOG) — fresh fixture, no tag
: >"$GH_LOG"
FIXTURE5="$TMP/repo5"
BARE5="$TMP/origin5.git"
setup_fixture "$FIXTURE5" "$BARE5"
cat >"$FIXTURE5/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

- nothing
EOF
run_release "$FIXTURE5"
cas5=0
if [ "$rc" -eq 0 ]; then
  echo "FAIL fail-closed CHANGELOG (exit 0, want non-zero: $out)"
  cas5=1
fi
if git -C "$FIXTURE5" rev-parse -q --verify "$tag_ref" >/dev/null; then
  echo "FAIL fail-closed CHANGELOG (tag created)"
  cas5=1
fi
if [ "$(gh_calls)" != "0" ]; then
  echo "FAIL fail-closed CHANGELOG (gh calls=$(gh_calls) want 0)"
  cas5=1
fi
if [ "$cas5" -eq 0 ]; then
  echo "OK   fail-closed CHANGELOG"
else
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_release_plugin: FAIL"
  exit 1
fi
echo
echo "test_release_plugin: all good"
