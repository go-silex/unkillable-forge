#!/usr/bin/env bash
# Pure-logic tests for scripts/forge-deploy.sh with stubbed gh/wrangler/sha256sum.
# Prefer real locked wrangler for temp-config .json parsing when available.
set -euo pipefail

# shellcheck source=tests/shell/lib/git-env-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-env-guard.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASH_BIN="${FORGE_BASH:-bash}"
DEPLOY="$ROOT/scripts/forge-deploy.sh"
fail=0

pass() { echo "  ok  $*"; }
bad() { echo "  FAIL $*" >&2; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
mkdir -p "$TMP/bin" "$TMP/instance" \
  "$TMP/releases/stage/manage" "$TMP/releases/stage/read" \
  "$TMP/releases/stage/read-unkillable" "$TMP/releases/stage/migrations"

WRANGLER_LOG="$TMP/wrangler.log"
GH_LOG="$TMP/gh.log"
: >"$WRANGLER_LOG"
: >"$GH_LOG"
export WRANGLER_LOG GH_LOG

# Fully-qualified signer expected by forge-deploy (no permissive fallback).
export FORGE_SIGNER_WORKFLOW="go-silex/unkillable-forge/.github/workflows/ci.yml"

write_sha256_ok() {
  cat >"$TMP/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-c" ]; then
  while read -r _hash name; do
    [ -z "${name:-}" ] && continue
    echo "${name}: OK"
  done <"$2"
  exit 0
fi
for f in "$@"; do
  printf '%s  %s\n' "$(printf '%s' "$f" | wc -c | awk '{printf "%064d", $1}')" "$f"
done
EOF
  chmod +x "$TMP/bin/sha256sum"
}

# Real Wrangler `d1 migrations list` prints ONLY unapplied names (or
# "✅ No migrations to apply!"). Stubs mirror that contract.
write_wrangler() {
  cat >"$TMP/bin/wrangler" <<'EOF'
#!/usr/bin/env bash
printf 'WRANGLER %s\n' "$*" >>"$WRANGLER_LOG"
case "$*" in
  *d1\ migrations\ list*)
    [ "${4:-}" = DB ] || { echo "expected DB binding" >&2; exit 1; }
    case "${FORGE_TEST_MIG_MODE:-empty}" in
      pending|apply-fail)
        echo "Migrations to be applied:"
        echo "┌───────────────────────────┐"
        echo "│ Name                      │"
        echo "├───────────────────────────┤"
        echo "│ 0003_previews_sharing.sql │"
        echo "└───────────────────────────┘"
        ;;
      fail)
        echo "ERROR: could not connect" >&2
        exit 2
        ;;
      empty|*)
        echo "✅ No migrations to apply!"
        ;;
    esac
    exit 0
    ;;
  *d1\ migrations\ apply*)
    [ "${4:-}" = DB ] || { echo "expected DB binding" >&2; exit 1; }
    [ "${FORGE_TEST_MIG_MODE:-empty}" != apply-fail ] || exit 2
    echo "Applied migrations"
    exit 0
    ;;
  *deploy*)
    # Capture --config path shape for assertions
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--config" ]; then
        printf 'CONFIG %s\n' "$arg" >>"$WRANGLER_LOG"
        cp "$arg" "$WRANGLER_LOG.$(basename "$arg")"
      fi
      prev="$arg"
    done
    echo "Uploaded"
    echo "Current Version ID: 11111111-1111-1111-1111-111111111111"
    exit 0
    ;;
esac
echo "wrangler stub: unhandled $*" >&2
exit 1
EOF
  chmod +x "$TMP/bin/wrangler"
  export WRANGLER="$TMP/bin/wrangler"
}

cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'GH %s\n' "$*" >>"$GH_LOG"
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  src="${FORGE_TEST_RELEASE_DIR:-}"
  [ -n "$src" ] || exit 1
  cp -p "$src"/forge-engine-*.tar.gz "$src"/release.json "$src"/SHA256SUMS .
  exit 0
fi
if [ "$1" = "attestation" ] && [ "$2" = "verify" ]; then
  # Require fully-qualified --signer-workflow
  has=0
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--signer-workflow" ]; then
      case "$arg" in
        */.github/workflows/*) has=1 ;;
        *) echo "bad signer: $arg" >&2; exit 1 ;;
      esac
    fi
    prev="$arg"
  done
  [ "$has" -eq 1 ] || { echo "missing --signer-workflow" >&2; exit 1; }
  case " $* " in *" --source-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "*) ;; *) exit 1 ;; esac
  case " $* " in *" --source-ref refs/heads/main "*) ;; *) exit 1 ;; esac
  exit 0
fi
if [ "$1" = "api" ]; then
  path=""
  jq=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--jq" ]; then jq="$arg"; fi
    prev="$arg"
  done
  # First non-flag arg after "api" is the path
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --jq) shift 2 || true; continue ;;
      --paginate) shift; continue ;;
      -*) shift; continue ;;
      *) path="$1"; break ;;
    esac
  done
  body=""
  case "$path" in
    repos/*/git/ref/tags/*)
      body='{"object":{"type":"commit","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
      ;;
    repos/*/commits/*/check-runs)
      body="$(python3 -c 'import json
names = ["check", "test", "test-os / macos-bash32", "test-bash32", "test-py39", "TruffleHog"]
names += [f"publisher-committed ({r}, {n})" for r in ("ubuntu-22.04", "ubuntu-22.04-arm", "macos-15-intel", "macos-15") for n in ("22", "26")]
names += [f"publisher-native-producer ({r}, {t})" for r,t in (("ubuntu-22.04", "linux-x64"), ("ubuntu-22.04-arm", "linux-arm64"), ("macos-15-intel", "darwin-x64"), ("macos-15", "darwin-arm64"))]
import os
if os.environ.get("FORGE_TEST_MISSING_MATRIX") == "1": names.pop()
print(json.dumps({"check_runs": [{"name": n, "conclusion": "success"} for n in names]}))')"
      ;;
    repos/*/commits/*)
      body='{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
      ;;
    repos/*/compare/*)
      body='{"status":"ahead"}'
      ;;
    repos/*)
      body='{"default_branch":"main"}'
      ;;
    *)
      body='{}'
      ;;
  esac
  if [ -n "$jq" ]; then
    printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); q=sys.argv[1]
# minimal jq subset used by forge-deploy
if q == ".default_branch":
  print(d["default_branch"])
elif q == ".sha":
  print(d["sha"])
elif q == ".status":
  print(d["status"])
elif q == ".object.sha":
  print(d["object"]["sha"])
else:
  raise SystemExit("unsupported jq in stub: "+q)
' "$jq"
  else
    printf '%s\n' "$body"
  fi
  exit 0
fi
exit 0
EOF
chmod +x "$TMP/bin/gh"
write_sha256_ok
write_wrangler
export PATH="$TMP/bin:$PATH"

STAGE="$TMP/releases/stage"
printf '%s\n' 'manage-js' >"$STAGE/manage/manageWorker.js"
printf '%s\n' 'read-generic-js' >"$STAGE/read/readWorker.js"
printf '%s\n' 'read-unk-js' >"$STAGE/read-unkillable/unkillableReadWorker.js"
printf '%s\n' '-- sql' >"$STAGE/migrations/0001_catalogue.sql"
printf '%s\n' '-- sql' >"$STAGE/migrations/0002_publication.sql"
printf '%s\n' '-- sql' >"$STAGE/migrations/0003_previews_sharing.sql"
cat >"$STAGE/release.json" <<'EOF'
{
  "engineVersion": "1.0.0",
  "rollbackCompatibleFrom": "1.0.0",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "wranglerVersion": "4.161.0",
  "compatibilityDate": "2025-02-14",
  "compatibilityFlags": [],
  "entries": {
    "manage": "manage/manageWorker.js",
    "read": "read/readWorker.js",
    "read-unkillable": "read-unkillable/unkillableReadWorker.js"
  },
  "readVariants": {"generic": "read", "unkillable": "read-unkillable"},
  "modules": [],
  "migrations": [
    {"name": "0001_catalogue.sql", "sha256": "aa"},
    {"name": "0002_publication.sql", "sha256": "bb"},
    {"name": "0003_previews_sharing.sql", "sha256": "cc"}
  ]
}
EOF

pack_release() {
  (
    cd "$STAGE"
    tar -czf "$TMP/releases/forge-engine-1.0.0.tar.gz" manage read read-unkillable migrations release.json
  )
  cp -p "$STAGE/release.json" "$TMP/releases/release.json"
  (
    cd "$TMP/releases"
    sha256sum forge-engine-1.0.0.tar.gz release.json >SHA256SUMS
  )
}
pack_release
export FORGE_TEST_RELEASE_DIR="$TMP/releases"

write_instance() {
  local dir="$1" variant="${2:-generic}"
  mkdir -p "$dir"
  cat >"$dir/instance.json" <<EOF
{"readVariant": "$variant"}
EOF
  cat >"$dir/manage.json" <<'EOF'
{
  "account_id": "acct-test-manage",
  "name": "forge-manage-test",
  "compatibility_date": "2025-02-14",
  "d1_databases": [{"binding": "DB", "database_id": "dddddddd-1111-1111-1111-111111111111", "database_name": "forge-db-test"}],
  "r2_buckets": [{"binding": "REVISION_BYTES", "bucket_name": "bytes"}]
}
EOF
  cat >"$dir/read.json" <<'EOF'
{
  "account_id": "acct-test-manage",
  "name": "forge-read-test",
  "compatibility_date": "2025-02-14",
  "d1_databases": [{"binding": "DB", "database_id": "dddddddd-1111-1111-1111-111111111111", "database_name": "forge-db-test"}],
  "r2_buckets": [{"binding": "REVISION_BYTES", "bucket_name": "bytes"}],
  "rules": [{"type": "Data", "globs": ["**/*.png"]}]
}
EOF
  printf 'CLOUDFLARE_API_TOKEN=secret-token-value\n' >"$dir/deploy.env"
  chmod 600 "$dir/deploy.env"
}
write_instance "$TMP/instance" generic

echo "forge-deploy.sh tests"

export FORGE_TEST_MISSING_MATRIX=1
if "$BASH_BIN" "$DEPLOY" verify --tag engine/v1.0.0 >"$TMP/missing-matrix.log" 2>&1; then
  bad "missing matrix leg accepted"
else
  pass "missing matrix leg rejected"
fi
unset FORGE_TEST_MISSING_MATRIX

# 0. refuse missing instance.json / readVariant
mkdir -p "$TMP/inst-novar"
cp "$TMP/instance/manage.json" "$TMP/inst-novar/"
cp "$TMP/instance/read.json" "$TMP/inst-novar/"
cp "$TMP/instance/deploy.env" "$TMP/inst-novar/"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-novar" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'instance.json\|readVariant'; then
  bad "refuse missing instance.json (rc=$rc out=$out)"
else
  pass "refuse missing instance.json"
fi

# 1. refuse build key
mkdir -p "$TMP/inst-build"
python3 - <<PY
import json
from pathlib import Path
src = Path("$TMP/instance/manage.json")
d = json.loads(src.read_text())
d["build"] = {"command": "echo no"}
Path("$TMP/inst-build/manage.json").write_text(json.dumps(d) + "\n")
PY
cp "$TMP/instance/read.json" "$TMP/inst-build/read.json"
cp "$TMP/instance/deploy.env" "$TMP/inst-build/deploy.env"
cp "$TMP/instance/instance.json" "$TMP/inst-build/instance.json"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-build" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'build'; then
  bad "refuse build key (rc=$rc out=$out)"
else
  pass "refuse build key"
fi

# 2. refuse missing account_id / database_id
mkdir -p "$TMP/inst-nodb"
python3 - <<PY
import json
from pathlib import Path
d = json.loads(Path("$TMP/instance/manage.json").read_text())
d["d1_databases"] = [{"binding": "DB", "database_name": "forge-db-test"}]
Path("$TMP/inst-nodb/manage.json").write_text(json.dumps(d) + "\n")
PY
cp "$TMP/instance/read.json" "$TMP/inst-nodb/read.json"
cp "$TMP/instance/deploy.env" "$TMP/inst-nodb/deploy.env"
cp "$TMP/instance/instance.json" "$TMP/inst-nodb/instance.json"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-nodb" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'database_id'; then
  bad "refuse missing database_id (rc=$rc out=$out)"
else
  pass "refuse missing database_id"
fi

# 3. checksum mismatch refusal
mkdir -p "$TMP/badsums"
cp "$TMP/releases"/forge-engine-*.tar.gz "$TMP/releases/release.json" "$TMP/badsums/"
echo "0000000000000000000000000000000000000000000000000000000000000000  forge-engine-1.0.0.tar.gz" >"$TMP/badsums/SHA256SUMS"
cat >"$TMP/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-c" ]; then
  echo "forge-engine-1.0.0.tar.gz: FAILED" >&2
  exit 1
fi
for f in "$@"; do
  printf '%s  %s\n' "$(printf '%s' "$f" | wc -c | awk '{printf "%064d", $1}')" "$f"
done
EOF
chmod +x "$TMP/bin/sha256sum"
export FORGE_TEST_RELEASE_DIR="$TMP/badsums"
set +e
out="$($BASH_BIN "$DEPLOY" verify --tag engine/v1.0.0 --repo example/repo 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  bad "checksum mismatch refusal (exit 0)"
else
  pass "checksum mismatch refusal"
fi
write_sha256_ok
export FORGE_TEST_RELEASE_DIR="$TMP/releases"

# 4. migrations require --apply-migrations (unapplied-only stub)
export FORGE_TEST_MIG_MODE=pending
write_wrangler
: >"$TMP/instance/deploys.jsonl"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -q 'apply-migrations'; then
  bad "migrations require --apply-migrations (rc=$rc out=$out)"
else
  pass "migrations require --apply-migrations"
fi

set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 --apply-migrations --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "deploy dry-run with --apply-migrations (rc=$rc out=$out)"
else
  pass "deploy dry-run with --apply-migrations"
fi
if [ -d "$TMP/instance/.forge-deploy.lock" ]; then
  bad "dry-run left lock: $out; contents: $(ls -la "$TMP/instance/.forge-deploy.lock")"
fi

# 4b. migrations list failure fails closed
export FORGE_TEST_MIG_MODE=fail
write_wrangler
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 --apply-migrations 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'migrations list failed\|exit'; then
  bad "migrations list failure closed (rc=$rc out=$out)"
else
  pass "migrations list failure fails closed"
fi
if [ -f "$TMP/instance/.forge-migration-pending" ]; then
  bad "list failure incorrectly marked as migration in progress"
else
  pass "list failure leaves no pending migration"
fi
export FORGE_TEST_MIG_MODE=apply-fail
if "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 --apply-migrations >"$TMP/apply-fail.log" 2>&1; then
  bad "migration apply failure accepted"
elif [ ! -f "$TMP/instance/.forge-migration-pending" ]; then
  bad "failed migration apply lost reconciliation marker"
else
  pass "failed migration apply leaves reconciliation marker"
fi
rm -f "$TMP/instance/.forge-migration-pending"

# 5. schema floor refusal on deploy of older tag (and rollback)
export FORGE_TEST_MIG_MODE=empty
write_wrangler
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m0","read":"r0"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.1.0","schemaFloor":"1.1.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T01:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'schema floor\|refuse'; then
  bad "deploy schema floor refusal (rc=$rc out=$out)"
else
  pass "deploy schema floor refusal"
fi

set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'schema floor\|refuse'; then
  bad "rollback schema floor refusal (rc=$rc out=$out)"
else
  pass "rollback schema floor refusal"
fi

# acceptance: floor allows target that was previously completed on this instance
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m0","read":"r0"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T01:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "rollback schema floor acceptance (rc=$rc out=$out)"
else
  pass "rollback schema floor acceptance"
fi

# refuse rollback to a tag never completed on this instance (floor alone is insufficient)
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'completed deployment'; then
  bad "rollback without completed target accepted (rc=$rc out=$out)"
else
  pass "rollback without completed target refused"
fi

# resume interrupted rollback (partial-rollback-manage matching tag+SHA)
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m0","read":"r0"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m1","read":"r1"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T01:00:00Z","mode":"deploy"}
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m-partial","read":"pending"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T02:00:00Z","mode":"partial-rollback-manage"}
EOF
export FORGE_TEST_MIG_MODE=empty
write_wrangler
: >"$WRANGLER_LOG"
set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "resume partial rollback (rc=$rc out=$out)"
elif ! printf '%s\n' "$out" | grep -qi 'resuming partial rollback'; then
  bad "resume partial rollback missing resume note (out=$out)"
elif ! grep -q '"mode": "rollback"' "$TMP/instance/deploys.jsonl"; then
  bad "resume partial rollback missing completed rollback row"
else
  pass "resume partial rollback"
fi

# 6. ledger append + schemaFloor + partial-manage then deploy; config ends with .json
export FORGE_TEST_MIG_MODE=empty
write_wrangler
: >"$WRANGLER_LOG"
: >"$TMP/instance/deploys.jsonl"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "ledger append deploy (rc=$rc out=$out)"
elif [ ! -s "$TMP/instance/deploys.jsonl" ]; then
  bad "ledger append (empty ledger)"
elif ! grep -q '"mode": "deploy"' "$TMP/instance/deploys.jsonl"; then
  bad "ledger append (mode missing): $(cat "$TMP/instance/deploys.jsonl")"
elif ! grep -q '"mode": "partial-manage"' "$TMP/instance/deploys.jsonl"; then
  bad "partial-manage ledger missing"
elif ! grep -q '"schemaFloor"' "$TMP/instance/deploys.jsonl"; then
  bad "schemaFloor missing from ledger"
elif ! grep -q '"r2_jurisdiction"' "$TMP/instance/deploys.jsonl"; then
  bad "r2_jurisdiction missing from ledger"
else
  pass "ledger append (partial + deploy + schemaFloor)"
fi

if ! grep -q 'CONFIG .*\.json' "$WRANGLER_LOG"; then
  bad "temp wrangler config missing .json suffix: $(grep CONFIG "$WRANGLER_LOG" || true)"
else
  pass "temp wrangler config uses .json suffix"
fi

if ! grep -q 'signer-workflow go-silex/unkillable-forge/.github/workflows/ci.yml' "$GH_LOG"; then
  bad "attestation missing fully-qualified signer-workflow"
else
  pass "attestation uses fully-qualified signer-workflow"
fi

# 6b. binding drift refused
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-OTHER","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes"},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes"}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'drift\|account_id'; then
  bad "binding drift refusal (rc=$rc out=$out)"
else
  pass "binding drift refusal"
fi

# 7. token never echoed; stdout of deploy must not leak wrangler noise on success path
: >"$TMP/instance/deploys.jsonl"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/instance" --tag engine/v1.0.0 2>&1)"
rc=$?
set -e
if printf '%s\n' "$out" | grep -q 'secret-token-value'; then
  bad "token echoed in deploy output"
else
  pass "token never echoed"
fi
if grep -q 'secret-token-value' "$WRANGLER_LOG" "$GH_LOG" 2>/dev/null; then
  bad "token appeared in stub logs"
else
  pass "token absent from stub logs"
fi

# 8. unkillable variant selects read-unkillable entry
write_instance "$TMP/inst-unk" unkillable
: >"$WRANGLER_LOG"
export FORGE_TEST_MIG_MODE=empty
write_wrangler
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-unk" --tag engine/v1.0.0 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "unkillable variant deploy (rc=$rc out=$out)"
elif ! grep -q 'deploy .*read-unkillable/unkillableReadWorker.js --no-bundle' "$WRANGLER_LOG"; then
  bad "unkillable entry not passed to Wrangler: $out"
else
  pass "unkillable readVariant deploy"
fi

# Assert the actual generated config, captured by the Wrangler stub.
if python3 - "$WRANGLER_LOG.read.wrangler.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8"))
assert c["name"] == "forge-read-test"
assert c["r2_buckets"][0]["bucket_name"] == "bytes"
assert {"type": "Data", "globs": ["**/*.png"]} in c["rules"]
PY
then
  pass "generated config preserves bindings and module rules"
else
  bad "generated config lost bindings or module rules"
fi

REAL_W="$ROOT/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"
if [ -x "$REAL_W" ] && command -v node >/dev/null 2>&1; then
  REAL_JS="$TMP/real-entry.js"
  printf 'export default { fetch() { return new Response("ok"); } }\n' >"$REAL_JS"
  GEN_JSON="$TMP/generated.wrangler.json"
  python3 - "$WRANGLER_LOG.read.wrangler.json" "$REAL_JS" "$GEN_JSON" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8"))
c["main"] = sys.argv[2]
json.dump(c, open(sys.argv[3], "w", encoding="utf-8"))
PY
  REAL_OUT="$TMP/real-dry"
  mkdir -p "$REAL_OUT"
  set +e
  real_out="$("$REAL_W" deploy --dry-run --config "$GEN_JSON" --outdir "$REAL_OUT" 2>&1)"
  real_rc=$?
  set -e
  if [ "$real_rc" -ne 0 ] || ! printf '%s\n' "$real_out" | grep -q 'REVISION_BYTES'; then
    bad "real wrangler did not preserve binding (rc=$real_rc): $(printf '%s' "$real_out" | tr '\n' ' ' | head -c 500)"
  else
    pass "real wrangler preserves generated binding"
  fi

  # Bare mktemp (no .json): Wrangler treats as TOML → empty/wrong parse.
  BARE="$(mktemp "$TMP/bare.XXXXXX")"
  cp "$GEN_JSON" "$BARE"
  set +e
  bare_out="$("$REAL_W" deploy --dry-run --config "$BARE" --outdir "$TMP/bare-out" 2>&1)"
  set -e
  if printf '%s\n' "$bare_out" | grep -qi 'forge-read-test'; then
    bad "bare mktemp unexpectedly preserved worker name (should misparse)"
  else
    pass "bare mktemp config does not preserve JSON name/bindings"
  fi

  # Real local migrations list empty-shape after apply already done in repo — sample parse.
  set +e
  mig_out="$("$REAL_W" d1 migrations list forge-manage-local --local --config "$ROOT/wrangler.manage.toml" 2>&1)"
  mig_rc=$?
  set -e
  if [ "$mig_rc" -ne 0 ]; then
    bad "real migrations list --local failed"
  elif printf '%s\n' "$mig_out" | grep -qi 'No migrations to apply'; then
    pass "real migrations list empty shape (No migrations to apply)"
  elif printf '%s\n' "$mig_out" | grep -E -q '[0-9]{4}_.+\.sql'; then
    pass "real migrations list unapplied filenames shape"
  else
    bad "real migrations list unexpected: $(printf '%s' "$mig_out" | tr '\n' ' ' | head -c 200)"
  fi
else
  pass "skip real wrangler evidence (node or binary missing)"
fi

write_instance "$TMP/guarded" generic
mkdir "$TMP/guarded/.forge-deploy.lock"
if "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/guarded" --tag engine/v1.0.0 --dry-run >"$TMP/locked.log" 2>&1; then
  bad "concurrent instance lock accepted"
else
  pass "concurrent instance lock rejected"
fi
rmdir "$TMP/guarded/.forge-deploy.lock"
touch "$TMP/guarded/.forge-migration-pending"
if "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/guarded" --tag engine/v1.0.0 --dry-run >"$TMP/pending.log" 2>&1; then
  bad "unreconciled migration accepted"
else
  pass "unreconciled migration rejected"
fi
rm "$TMP/guarded/.forge-migration-pending"
: >"$WRANGLER_LOG"
if ! "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/guarded" --tag engine/v1.0.0 --dry-run --apply-migrations >"$TMP/dry.log" 2>&1; then
  bad "dry-run with migration flag failed"
elif grep -q 'd1 migrations' "$WRANGLER_LOG"; then
  bad "dry-run contacted remote migrations"
else
  pass "dry-run never contacts remote migrations"
fi

python3 - "$TMP/guarded/read.json" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
c["name"] = "forge-manage-test"
json.dump(c, open(p, "w", encoding="utf-8"))
PY
if "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/guarded" --tag engine/v1.0.0 --dry-run >"$TMP/pair.log" 2>&1; then
  bad "identical role names accepted"
else
  pass "identical role names rejected"
fi

# R2 jurisdiction must match across manage/read
write_instance "$TMP/jur" generic
python3 - "$TMP/jur/read.json" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
c["r2_buckets"][0]["jurisdiction"] = "eu"
json.dump(c, open(p, "w", encoding="utf-8"))
PY
if "$BASH_BIN" "$DEPLOY" deploy --instance-dir "$TMP/jur" --tag engine/v1.0.0 --dry-run >"$TMP/jur.log" 2>&1; then
  bad "R2 jurisdiction mismatch accepted"
else
  pass "R2 jurisdiction mismatch rejected"
fi

# Contract migration refused while running Workers are below the new floor
write_instance "$TMP/contract" generic
cat >"$TMP/contract/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.0.0","engineVersion":"1.0.0","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rollbackCompatibleFrom":"1.0.0","schemaFloor":"1.0.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"bindings":{"manage":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""},"read":{"account_id":"acct-test-manage","d1_database_id":"dddddddd-1111-1111-1111-111111111111","r2_bucket_name":"bytes","r2_jurisdiction":""}},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
EOF
python3 - "$STAGE/release.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
d["rollbackCompatibleFrom"] = "1.1.0"
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
print()
PY
pack_release
export FORGE_TEST_MIG_MODE=pending
write_wrangler
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/contract" --tag engine/v1.0.0 --apply-migrations 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'intermediate release\|new schema floor'; then
  bad "contract migration below running floor accepted (rc=$rc out=$out)"
else
  pass "contract migration below running floor refused"
fi
python3 - "$STAGE/release.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
d["rollbackCompatibleFrom"] = "1.0.0"
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
print()
PY
pack_release

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_forge_deploy: FAIL"
  exit 1
fi
echo
echo "test_forge_deploy: all good"
