#!/usr/bin/env bash
# Stubbed wrangler tests for scripts/forge-bootstrap.sh (validation + idempotency).
set -euo pipefail

# shellcheck source=tests/shell/lib/git-env-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-env-guard.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASH_BIN="${FORGE_BASH:-bash}"
BOOT="$ROOT/scripts/forge-bootstrap.sh"
fail=0

pass() { echo "  ok  $*"; }
bad() { echo "  FAIL $*" >&2; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
unset WRANGLER
mkdir -p "$TMP/bin" "$TMP/instance"

WRANGLER_LOG="$TMP/wrangler.log"
: >"$WRANGLER_LOG"
export WRANGLER_LOG

# In-memory D1 stub state files
STATE="$TMP/state"
mkdir -p "$STATE"
: >"$STATE/instance_meta.json"
: >"$STATE/principals.json"
: >"$STATE/role_grants.json"
printf '[]\n' >"$STATE/instance_meta.json"
printf '[]\n' >"$STATE/principals.json"
printf '[]\n' >"$STATE/role_grants.json"

cat >"$TMP/bin/wrangler" <<'EOF'
#!/usr/bin/env bash
printf 'WRANGLER %s\n' "$*" >>"$WRANGLER_LOG"
# Expect: d1 execute <db> --remote --config <cfg> --command <sql> --json
sql=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--command" ]; then sql="$arg"; fi
  prev="$arg"
done
[ -n "$sql" ] || { echo 'missing --command' >&2; exit 1; }
STATE_DIR="${FORGE_BOOTSTRAP_STATE:?}"
export FORGE_BOOTSTRAP_SQL="$sql"
python3 - <<'PY'
import json, os, re, sys
from pathlib import Path
state = Path(os.environ["FORGE_BOOTSTRAP_STATE"])
sql = os.environ["FORGE_BOOTSTRAP_SQL"].strip().rstrip(";")

def load(name):
    return json.loads((state / name).read_text(encoding="utf-8"))

def save(name, rows):
    (state / name).write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")

def ok(rows):
    print(json.dumps([{"results": rows, "success": True}]))

def lit(s):
    # unwrap SQL string literal with doubled quotes
    if not (s.startswith("'") and s.endswith("'")):
        raise SystemExit(f"bad literal {s!r}")
    return s[1:-1].replace("''", "'")

if sql.startswith("SELECT instance_id FROM instance_meta"):
    rows = load("instance_meta.json")
    ok([{"instance_id": r["instance_id"]} for r in rows])
elif sql.startswith("SELECT instance_id, contract_version FROM instance_meta"):
    rows = load("instance_meta.json")
    ok([{"instance_id": r["instance_id"], "contract_version": r["contract_version"]} for r in rows])
elif sql.startswith("INSERT INTO instance_meta"):
    m = re.search(r"SELECT 1, ('(?:[^']|'')*'), 1, (\d+) WHERE NOT EXISTS", sql)
    if not m:
        raise SystemExit("unparsed instance insert")
    instance_id = lit(m.group(1))
    created_at = int(m.group(2))
    rows = load("instance_meta.json")
    if not rows:
        rows = [{"singleton": 1, "instance_id": instance_id, "contract_version": 1, "created_at": created_at}]
        save("instance_meta.json", rows)
    ok([])
elif sql.startswith("SELECT principal_id, status, issuer, subject, email_hint FROM principals WHERE email_hint"):
    m = re.search(r"email_hint = ('(?:[^']|'')*')", sql)
    email = lit(m.group(1))
    rows = [r for r in load("principals.json") if r.get("email_hint") == email]
    ok(rows)
elif sql.startswith("SELECT principal_id, status, issuer, subject, email_hint FROM principals WHERE issuer"):
    m = re.search(r"issuer = ('(?:[^']|'')*') AND subject = ('(?:[^']|'')*')", sql)
    issuer, subject = lit(m.group(1)), lit(m.group(2))
    rows = [r for r in load("principals.json") if r.get("issuer") == issuer and r.get("subject") == subject]
    ok(rows)
elif sql.startswith("SELECT role_grant_id, principal_id, origin FROM role_grants"):
    rows = [r for r in load("role_grants.json") if r.get("role") == "admin" and r.get("scope_kind") == "installation" and r.get("revoked_at") is None]
    ok([{"role_grant_id": r["role_grant_id"], "principal_id": r["principal_id"], "origin": r["origin"]} for r in rows])
elif sql.startswith("INSERT INTO role_grants"):
    m = re.search(
        r"SELECT ('(?:[^']|'')*'), ('(?:[^']|'')*'), 'admin', 'installation', NULL, 'bootstrap', (\d+), NULL, NULL, NULL WHERE NOT EXISTS",
        sql,
    )
    if not m:
        raise SystemExit("unparsed role_grants insert")
    rg, pid, granted_at = lit(m.group(1)), lit(m.group(2)), int(m.group(3))
    rows = load("role_grants.json")
    active = [r for r in rows if r.get("role") == "admin" and r.get("scope_kind") == "installation" and r.get("revoked_at") is None]
    if not active:
        rows.append({
            "role_grant_id": rg,
            "principal_id": pid,
            "role": "admin",
            "scope_kind": "installation",
            "scope_page_id": None,
            "origin": "bootstrap",
            "granted_at": granted_at,
            "granted_by": None,
            "revoked_at": None,
            "revoked_by": None,
        })
        save("role_grants.json", rows)
    ok([])
else:
    sys.stderr.write(f"unhandled sql: {sql}\n")
    sys.exit(1)
PY
EOF
chmod +x "$TMP/bin/wrangler"
export WRANGLER="$TMP/bin/wrangler"
export FORGE_BOOTSTRAP_STATE="$STATE"
export PATH="$TMP/bin:$PATH"

cat >"$TMP/instance/manage.json" <<'EOF'
{
  "account_id": "acct-bootstrap",
  "name": "forge-manage-test",
  "d1_databases": [{"binding": "DB", "database_name": "forge-db-test"}]
}
EOF
printf 'CLOUDFLARE_API_TOKEN=secret-token-value\n' >"$TMP/instance/deploy.env"
chmod 600 "$TMP/instance/deploy.env"

echo "forge-bootstrap.sh tests"

# 1. reject bad instance-id
set +e
out="$($BASH_BIN "$BOOT" instance --instance-dir "$TMP/instance" --instance-id 'BAD_ID' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'instance-id'; then
  bad "reject bad instance-id (rc=$rc out=$out)"
else
  pass "reject bad instance-id"
fi

# 2. insert instance_meta
set +e
out="$($BASH_BIN "$BOOT" instance --instance-dir "$TMP/instance" --instance-id 'staging-one' 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "instance insert (rc=$rc out=$out)"
elif ! grep -q 'staging-one' "$STATE/instance_meta.json"; then
  bad "instance insert not persisted"
else
  pass "instance insert"
fi

# 3. idempotent same instance-id
set +e
out="$($BASH_BIN "$BOOT" instance --instance-dir "$TMP/instance" --instance-id 'staging-one' 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$out" | grep -qi 'skip'; then
  bad "instance idempotent skip (rc=$rc out=$out)"
else
  pass "instance idempotent skip"
fi

# 4. refuse different instance-id
set +e
out="$($BASH_BIN "$BOOT" instance --instance-dir "$TMP/instance" --instance-id 'other-id' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'refusing'; then
  bad "refuse different instance-id (rc=$rc out=$out)"
else
  pass "refuse different instance-id"
fi

# Seed principal (simulates post-sign-in self-registration)
python3 - <<PY
import json
from pathlib import Path
Path("$STATE/principals.json").write_text(json.dumps([{
  "principal_id": "pr_abcdefghijklmnopqrstuvwxyz",
  "issuer": "https://example.cloudflareaccess.com",
  "subject": "user-sub-1",
  "status": "active",
  "email_hint": "admin@example.com",
}]) + "\n")
PY

# 5. reject bad issuer
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'http://insecure.example' --subject 'user-sub-1' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'issuer'; then
  bad "reject bad issuer (rc=$rc out=$out)"
else
  pass "reject bad issuer"
fi

# 6. refuse missing principal
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'https://example.cloudflareaccess.com' --subject 'no-such' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'sign in'; then
  bad "refuse missing principal (rc=$rc out=$out)"
else
  pass "refuse missing principal"
fi

# 7. grant first admin
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'https://example.cloudflareaccess.com' --subject 'user-sub-1' 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "first-admin grant (rc=$rc out=$out)"
elif ! grep -q 'bootstrap' "$STATE/role_grants.json"; then
  bad "first-admin not persisted"
else
  pass "first-admin grant"
fi

# 8. idempotent same admin
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'https://example.cloudflareaccess.com' --subject 'user-sub-1' 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$out" | grep -qi 'skip'; then
  bad "first-admin idempotent (rc=$rc out=$out)"
else
  pass "first-admin idempotent"
fi

# 9. refuse second admin for other principal
python3 - <<PY
import json
from pathlib import Path
p = Path("$STATE/principals.json")
rows = json.loads(p.read_text())
rows.append({
  "principal_id": "pr_zyxwvutsrqponmlkjihgfedcba",
  "issuer": "https://example.cloudflareaccess.com",
  "subject": "other-sub",
  "status": "active",
  "email_hint": "other@example.com",
})
p.write_text(json.dumps(rows) + "\n")
PY
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'https://example.cloudflareaccess.com' --subject 'other-sub' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'already exists'; then
  bad "refuse second admin (rc=$rc out=$out)"
else
  pass "refuse second admin"
fi

# 10. --email resolution works when no admin (reset grants)
printf '[]\n' >"$STATE/role_grants.json"
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --email 'admin@example.com' 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  bad "first-admin via --email (rc=$rc out=$out)"
else
  pass "first-admin via --email"
fi

# 11. token never echoed
if printf '%s\n' "$out" | grep -q 'secret-token-value'; then
  bad "token echoed"
else
  pass "token never echoed"
fi
if grep -q 'secret-token-value' "$WRANGLER_LOG"; then
  bad "token in wrangler log"
else
  pass "token absent from wrangler log"
fi

# 12. inactive principal refused
printf '[]\n' >"$STATE/role_grants.json"
python3 - <<PY
import json
from pathlib import Path
p = Path("$STATE/principals.json")
rows = json.loads(p.read_text())
for r in rows:
    if r["subject"] == "user-sub-1":
        r["status"] = "disabled"
p.write_text(json.dumps(rows) + "\n")
PY
set +e
out="$($BASH_BIN "$BOOT" first-admin --instance-dir "$TMP/instance" --issuer 'https://example.cloudflareaccess.com' --subject 'user-sub-1' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qi 'not active'; then
  bad "refuse inactive principal (rc=$rc out=$out)"
else
  pass "refuse inactive principal"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "test_forge_bootstrap: FAIL"
  exit 1
fi
echo
echo "test_forge_bootstrap: all good"
