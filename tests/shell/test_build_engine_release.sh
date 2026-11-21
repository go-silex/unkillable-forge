#!/usr/bin/env bash
# Offline shape tests for scripts/build-engine-release.sh (stubbed wrangler, no network).
# Version is derived from engine.json (never hard-coded independently of that fixture).
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
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/out" "$TMP/out2"

cp "$ROOT/scripts/build-engine-release.sh" "$TMP/repo/"
mkdir -p "$TMP/repo/scripts" "$TMP/repo/migrations" "$TMP/repo/docs" \
  "$TMP/repo/node_modules/@cloudflare/vitest-plugin/node_modules/.bin"
cp "$ROOT/scripts/check_plugin_versions.py" "$TMP/repo/scripts/"
cp "$ROOT/scripts/build-engine-release.sh" "$TMP/repo/scripts/"
cp "$ROOT/engine.json" "$TMP/repo/engine.json"
cp "$ROOT/docs/engine-changelog.md" "$TMP/repo/docs/engine-changelog.md"
cp "$ROOT/wrangler.manage.toml" "$TMP/repo/wrangler.manage.toml"
cp "$ROOT/wrangler.read.toml" "$TMP/repo/wrangler.read.toml"
cp "$ROOT/wrangler.read.generic.toml" "$TMP/repo/wrangler.read.generic.toml"
cp "$ROOT"/migrations/*.sql "$TMP/repo/migrations/"

ENGINE_VERSION="$(python3 -c 'import json; print(json.load(open("'"$TMP/repo/engine.json"'"))["version"])')"

# Stub wrangler: --version + deploy --dry-run --outdir for three roles.
# Emits build-specific files that the build must exclude.
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
# Timestamped README must not land in the release artifact.
printf 'Built at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$outdir/README.md"
printf '{"sourceRoot":"%s"}\n' "$outdir" >"$outdir/bundle.js.map"
case "$config" in
  *wrangler.manage.toml)
    printf 'manage-module\n' >"$outdir/manageWorker.js"
    ;;
  *wrangler.read.generic.toml)
    printf 'read-generic-module\n' >"$outdir/readWorker.js"
    ;;
  *wrangler.read.toml)
    printf 'read-unkillable-module\n' >"$outdir/unkillableReadWorker.js"
    printf 'PNG\n' >"$outdir/icon.png"
    printf 'text\n' >"$outdir/note.txt"
    ;;
  *)
    echo "unexpected config: $config" >&2
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

echo "build-engine-release.sh tests (engineVersion=$ENGINE_VERSION)"

set +e
out="$($BASH_BIN "$TMP/repo/scripts/build-engine-release.sh" "$TMP/out" 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "build exit $rc: $out"
else
  pass "build exits 0"
fi

TARBALL="$TMP/out/forge-engine-${ENGINE_VERSION}.tar.gz"
if [ ! -f "$TARBALL" ]; then
  bad "tarball missing (expected forge-engine-${ENGINE_VERSION}.tar.gz)"
else
  pass "tarball present (version from engine.json)"
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
python3 - "$TMP/out/release.json" "$ENGINE_VERSION" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
want = sys.argv[2]
required = [
    "engineVersion", "rollbackCompatibleFrom", "sourceCommit", "wranglerVersion",
    "compatibilityDate", "compatibilityFlags", "entries", "modules", "migrations",
    "readVariants",
]
missing = [k for k in required if k not in doc]
if missing:
    raise SystemExit(f"missing keys {missing}")
if doc["engineVersion"] != want:
    raise SystemExit(f"engineVersion {doc['engineVersion']!r} ≠ {want!r}")
if not doc["sourceCommit"]:
    raise SystemExit("sourceCommit empty")
entries = doc["entries"]
for role in ("manage", "read", "read-unkillable"):
    if role not in entries or not str(entries[role]).startswith(f"{role}/"):
        raise SystemExit(f"entries.{role}")
if doc["readVariants"] != {"generic": "read", "unkillable": "read-unkillable"}:
    raise SystemExit("readVariants")
for role in ("manage", "read", "read-unkillable"):
    if not any(m.get("entry") and m.get("role") == role for m in doc["modules"]):
        raise SystemExit(f"entry flag for {role}")
paths = {m["path"] for m in doc["modules"]}
if any(p.endswith("README.md") or p == "README.md" or "/README.md" in p for p in paths):
    raise SystemExit("README.md must be excluded from modules")
if not any(p.endswith(".png") for p in paths):
    raise SystemExit("missing png sibling")
if not any(p.endswith(".txt") for p in paths):
    raise SystemExit("missing txt sibling")
if not any("readWorker.js" in p for p in paths):
    raise SystemExit("missing generic readWorker")
if not any("unkillableReadWorker.js" in p for p in paths):
    raise SystemExit("missing unkillableReadWorker")
if len(doc["migrations"]) < 1:
    raise SystemExit("migrations")
print("ok")
PY
shape_rc=$?
set -e
if [ "$shape_rc" -eq 0 ]; then
  pass "release.json shape (both read variants)"
else
  bad "release.json shape"
fi

# Tarball and manifest must not contain nondeterministic files.
set +e
python3 - "$TARBALL" <<'PY'
import gzip, io, sys, tarfile
raw = gzip.open(sys.argv[1], "rb").read()
with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
    names = tar.getnames()
if any(n == "README.md" or n.endswith("/README.md") or n.endswith(".map") for n in names):
    raise SystemExit("nondeterministic file in tarball: " + ", ".join(names))
need = ("manage/", "read/", "read-unkillable/", "release.json", "migrations/")
for prefix in need:
    if not any(n == prefix.rstrip("/") or n.startswith(prefix) for n in names):
        raise SystemExit(f"missing {prefix} in {names}")
print("ok")
PY
tar_rc=$?
set -e
if [ "$tar_rc" -eq 0 ]; then
  pass "tarball excludes README and maps; has three roles"
else
  bad "tarball contents"
fi

if ! grep -q "forge-engine-${ENGINE_VERSION}.tar.gz" "$TMP/out/SHA256SUMS" || ! grep -q 'release.json' "$TMP/out/SHA256SUMS"; then
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

# Determinism: second build must match byte-for-byte
set +e
out2="$($BASH_BIN "$TMP/repo/scripts/build-engine-release.sh" "$TMP/out2" 2>&1)"
rc2=$?
set -e
if [ "$rc2" -ne 0 ]; then
  bad "second build exit $rc2: $out2"
elif ! cmp -s "$TARBALL" "$TMP/out2/forge-engine-${ENGINE_VERSION}.tar.gz"; then
  bad "tarball not deterministic across rebuilds"
elif ! cmp -s "$TMP/out/release.json" "$TMP/out2/release.json"; then
  bad "release.json not deterministic"
else
  pass "deterministic rebuild (Python tar/gzip)"
fi

# Exercise the actual release builder twice with the locked Wrangler.
REAL_W="$ROOT/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"
if [ -x "$REAL_W" ] && command -v node >/dev/null 2>&1; then
  mkdir -p "$TMP/real-out" "$TMP/real-out2"
  set +e
  real_log="$($BASH_BIN "$ROOT/scripts/build-engine-release.sh" "$TMP/real-out" 2>&1)"
  real_rc=$?
  real_log2="$($BASH_BIN "$ROOT/scripts/build-engine-release.sh" "$TMP/real-out2" 2>&1)"
  real_rc2=$?
  set -e
  if [ "$real_rc" -ne 0 ] || [ "$real_rc2" -ne 0 ]; then
    bad "real builds failed: $real_rc $real_rc2 $real_log $real_log2"
  elif ! cmp -s "$TMP/real-out/forge-engine-${ENGINE_VERSION}.tar.gz" "$TMP/real-out2/forge-engine-${ENGINE_VERSION}.tar.gz" ||
       ! cmp -s "$TMP/real-out/release.json" "$TMP/real-out2/release.json" ||
       ! cmp -s "$TMP/real-out/SHA256SUMS" "$TMP/real-out2/SHA256SUMS"; then
    bad "real Wrangler builds differ"
  else
    pass "real Wrangler builds are byte-for-byte identical"
  fi
else
  pass "skip real Wrangler (node or binary missing)"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_build_engine_release: FAIL"
  exit 1
fi
echo
echo "test_build_engine_release: all good"
