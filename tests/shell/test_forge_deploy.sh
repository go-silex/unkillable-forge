#!/usr/bin/env bash
# Pure-logic tests for scripts/forge-deploy.sh with stubbed gh/wrangler/sha256sum.
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
mkdir -p "$TMP/bin" "$TMP/instance" "$TMP/releases/stage/manage" "$TMP/releases/stage/read" "$TMP/releases/stage/migrations"

WRANGLER_LOG="$TMP/wrangler.log"
GH_LOG="$TMP/gh.log"
: >"$WRANGLER_LOG"
: >"$GH_LOG"
export WRANGLER_LOG GH_LOG

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

write_wrangler() {
  cat >"$TMP/bin/wrangler" <<'EOF'
#!/usr/bin/env bash
printf 'WRANGLER %s\n' "$*" >>"$WRANGLER_LOG"
case "$*" in
  *d1\ migrations\ list*)
    if [ "${FORGE_TEST_MIG_MODE:-applied}" = "pending" ]; then
      echo "Pending:"
      echo "❌ 0003_previews_sharing.sql"
      echo "Applied:"
      echo "✅ 0001_catalogue.sql"
      echo "✅ 0002_publication.sql"
    elif [ "${FORGE_TEST_MIG_MODE:-applied}" = "unknown" ]; then
      echo "✅ 0001_catalogue.sql"
      echo "✅ 0002_publication.sql"
      echo "✅ 0009_future.sql"
    else
      echo "✅ 0001_catalogue.sql"
      echo "✅ 0002_publication.sql"
      echo "✅ 0003_previews_sharing.sql"
    fi
    exit 0
    ;;
  *d1\ migrations\ apply*)
    echo "Applied migrations"
    exit 0
    ;;
  *deploy*)
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
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    repos/*/git/ref/tags/*)
      echo '{"object":{"type":"commit","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
      ;;
    repos/*/commits/*)
      echo '{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
      ;;
    repos/*/compare/*)
      echo '{"status":"ahead"}'
      ;;
    *)
      if echo "$2" | grep -q '/check-runs'; then
        echo '{"check_runs":[{"name":"check","conclusion":"success"},{"name":"test","conclusion":"success"},{"name":"test-os / macos-bash32","conclusion":"success"},{"name":"test-bash32","conclusion":"success"},{"name":"test-py39","conclusion":"success"}]}'
      else
        echo '{"default_branch":"main"}'
      fi
      ;;
  esac
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
printf '%s\n' 'read-js' >"$STAGE/read/unkillableReadWorker.js"
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
    "read": "read/unkillableReadWorker.js"
  },
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
    tar -czf "$TMP/releases/forge-engine-1.0.0.tar.gz" manage read migrations release.json
  )
  cp -p "$STAGE/release.json" "$TMP/releases/release.json"
  (
    cd "$TMP/releases"
    sha256sum forge-engine-1.0.0.tar.gz release.json >SHA256SUMS
  )
}
pack_release
export FORGE_TEST_RELEASE_DIR="$TMP/releases"

cat >"$TMP/instance/manage.json" <<'EOF'
{
  "account_id": "acct-test-manage",
  "name": "forge-manage-test",
  "d1_databases": [{"binding": "DB", "database_name": "forge-db-test"}],
  "r2_buckets": [{"binding": "REVISION_BYTES", "bucket_name": "bytes"}]
}
EOF
cat >"$TMP/instance/read.json" <<'EOF'
{
  "account_id": "acct-test-manage",
  "name": "forge-read-test",
  "d1_databases": [{"binding": "DB", "database_name": "forge-db-test"}],
  "r2_buckets": [{"binding": "REVISION_BYTES", "bucket_name": "bytes"}],
  "rules": [{"type": "Data", "globs": ["**/*.png"]}]
}
EOF
printf 'CLOUDFLARE_API_TOKEN=secret-token-value\n' >"$TMP/instance/deploy.env"
chmod 600 "$TMP/instance/deploy.env"

echo "forge-deploy.sh tests"

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
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-build" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'build'; then
  bad "refuse build key (rc=$rc out=$out)"
else
  pass "refuse build key"
fi

# 2. refuse missing account_id
mkdir -p "$TMP/inst-noacct"
python3 - <<PY
import json
from pathlib import Path
d = json.loads(Path("$TMP/instance/manage.json").read_text())
del d["account_id"]
Path("$TMP/inst-noacct/manage.json").write_text(json.dumps(d) + "\n")
PY
cp "$TMP/instance/read.json" "$TMP/inst-noacct/read.json"
cp "$TMP/instance/deploy.env" "$TMP/inst-noacct/deploy.env"
set +e
out="$($BASH_BIN "$DEPLOY" deploy --instance-dir "$TMP/inst-noacct" --tag engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'account_id'; then
  bad "refuse missing account_id (rc=$rc out=$out)"
else
  pass "refuse missing account_id"
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

# 4. migrations require --apply-migrations
export FORGE_TEST_MIG_MODE=pending
write_wrangler
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

# 5. rollback compatibility refusal
export FORGE_TEST_MIG_MODE=unknown
write_wrangler
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.1.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'refuse rollback'; then
  bad "rollback compatibility refusal (rc=$rc out=$out)"
else
  pass "rollback compatibility refusal"
fi

# acceptance: current rollbackCompatibleFrom <= target
cat >"$TMP/instance/deploys.jsonl" <<'EOF'
{"tag":"engine/v1.1.0","engineVersion":"1.1.0","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rollbackCompatibleFrom":"1.0.0","workerVersionIds":{"manage":"m","read":"r"},"workerNames":{"manage":"forge-manage-test","read":"forge-read-test"},"timestamp":"2026-01-01T00:00:00Z","mode":"deploy"}
EOF
set +e
out="$($BASH_BIN "$DEPLOY" rollback --instance-dir "$TMP/instance" --to engine/v1.0.0 --dry-run 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "rollback compatibility acceptance (rc=$rc out=$out)"
else
  pass "rollback compatibility acceptance"
fi

# 6. ledger append
export FORGE_TEST_MIG_MODE=applied
write_wrangler
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
else
  pass "ledger append"
fi

# 7. token never echoed
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

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_forge_deploy: FAIL"
  exit 1
fi
echo
echo "test_forge_deploy: all good"
