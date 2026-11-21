#!/usr/bin/env bash
# Offline shape tests for scripts/build-engine-release.sh (stubbed wrangler, no network).
set -euo pipefail

# shellcheck source=tests/shell/lib/git-env-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-env-guard.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASH_BIN="${FORGE_BASH:-bash}"
fail=0

pass() { echo "  ok  $*"; }
bad() { echo "  FAIL $*" >&2; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
unset WRANGLER
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/out"

# Minimal repo fixture with engine.json, wrangler profiles, migrations, fake git sha.
cp "$ROOT/scripts/build-engine-release.sh" "$TMP/repo/"
mkdir -p "$TMP/repo/scripts" "$TMP/repo/migrations" "$TMP/repo/docs" \
  "$TMP/repo/node_modules/@cloudflare/vitest-plugin/node_modules/.bin"
cp "$ROOT/scripts/check_plugin_versions.py" "$TMP/repo/scripts/"
cp "$ROOT/scripts/build-engine-release.sh" "$TMP/repo/scripts/"
cp "$ROOT/engine.json" "$TMP/repo/engine.json"
cp "$ROOT/docs/engine-changelog.md" "$TMP/repo/docs/engine-changelog.md"
cp "$ROOT/wrangler.manage.toml" "$TMP/repo/wrangler.manage.toml"
cp "$ROOT/wrangler.read.toml" "$TMP/repo/wrangler.read.toml"
cp "$ROOT"/migrations/*.sql "$TMP/repo/migrations/"

# Stub wrangler: --version + deploy --dry-run --outdir
cat >"$TMP/repo/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "4.161.0"
  exit 0
fi
outdir=""
config=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--outdir" ]; then outdir="$arg"; fi
  if [ "$prev" = "--config" ]; then config="$arg"; fi
  prev="$arg"
done
[ -n "$outdir" ] || exit 1
mkdir -p "$outdir"
case "$config" in
  *manage*)
    printf 'manage-module\n' >"$outdir/manageWorker.js"
    ;;
  *read*)
    printf 'read-module\n' >"$outdir/unkillableReadWorker.js"
    printf 'PNG\n' >"$outdir/icon.png"
    printf 'text\n' >"$outdir/note.txt"
    ;;
  *)
    exit 1
    ;;
esac
exit 0
EOF
chmod +x "$TMP/repo/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"

git -C "$TMP/repo" init -b main >/dev/null 2>&1
git -C "$TMP/repo" config user.email "test@example.com"
git -C "$TMP/repo" config user.name "test"
git -C "$TMP/repo" config commit.gpgsign false
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -m "fixture" >/dev/null 2>&1

echo "build-engine-release.sh tests"

set +e
out="$($BASH_BIN "$TMP/repo/scripts/build-engine-release.sh" "$TMP/out" 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "build exit $rc: $out"
else
  pass "build exits 0"
fi

if [ ! -f "$TMP/out/forge-engine-1.0.0.tar.gz" ]; then
  bad "tarball missing"
else
  pass "tarball present"
fi
if [ ! -f "$TMP/out/release.json" ]; then
  bad "release.json missing"
else
  pass "release.json present"
fi
if [ ! -f "$TMP/out/SHA256SUMS" ]; then
  bad "SHA256SUMS missing"
else
  pass "SHA256SUMS present"
fi

set +e
python3 - "$TMP/out/release.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
required = [
    "engineVersion", "rollbackCompatibleFrom", "sourceCommit", "wranglerVersion",
    "compatibilityDate", "compatibilityFlags", "entries", "modules", "migrations",
]
missing = [k for k in required if k not in doc]
if missing:
    raise SystemExit(f"missing keys {missing}")
if doc["engineVersion"] != "1.0.0":
    raise SystemExit("engineVersion")
if doc["rollbackCompatibleFrom"] != "1.0.0":
    raise SystemExit("rollbackCompatibleFrom")
if not doc["sourceCommit"]:
    raise SystemExit("sourceCommit empty")
if doc["entries"].get("manage", "").startswith("manage/") is False:
    raise SystemExit("manage entry")
if doc["entries"].get("read", "").startswith("read/") is False:
    raise SystemExit("read entry")
if not any(m.get("entry") and m.get("role") == "manage" for m in doc["modules"]):
    raise SystemExit("manage entry flag")
if not any(m.get("entry") and m.get("role") == "read" for m in doc["modules"]):
    raise SystemExit("read entry flag")
paths = {m["path"] for m in doc["modules"]}
if not any(p.endswith(".png") for p in paths):
    raise SystemExit("missing png sibling")
if not any(p.endswith(".txt") for p in paths):
    raise SystemExit("missing txt sibling")
if len(doc["migrations"]) < 1:
    raise SystemExit("migrations")
for row in doc["migrations"]:
    if "name" not in row or "sha256" not in row:
        raise SystemExit("migration row")
print("ok")
PY
shape_rc=$?
set -e
if [ "$shape_rc" -eq 0 ]; then
  pass "release.json shape"
else
  bad "release.json shape"
fi

if ! grep -q 'forge-engine-1.0.0.tar.gz' "$TMP/out/SHA256SUMS" || ! grep -q 'release.json' "$TMP/out/SHA256SUMS"; then
  bad "SHA256SUMS coverage"
else
  pass "SHA256SUMS coverage"
fi

set +e
(
  cd "$TMP/out"
  sha256sum -c SHA256SUMS >/dev/null
)
sum_rc=$?
set -e
if [ "$sum_rc" -eq 0 ]; then
  pass "SHA256SUMS verify"
else
  bad "SHA256SUMS verify"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_build_engine_release: FAIL"
  exit 1
fi
echo
echo "test_build_engine_release: all good"
