#!/usr/bin/env bash
# Operator bootstrap for a new Forge instance (instance_meta + first admin).
# Uses the same private --instance-dir / deploy.env / wrangler conventions as forge-deploy.sh.
# SQL is parameterless and built only from validated literals (no shell interpolation of unchecked input).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "forge-bootstrap: $*" >&2; exit 1; }
info() { echo "forge-bootstrap: $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  forge-bootstrap.sh instance --instance-dir <dir> --instance-id <id>
  forge-bootstrap.sh first-admin --instance-dir <dir> (--issuer <https-url> --subject <sub> | --email <hint>)
EOF
}

DEFAULT_W="$ROOT/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"

resolve_wrangler() {
  if [ -n "${WRANGLER:-}" ]; then
    [ -x "$WRANGLER" ] || die "WRANGLER is not executable: $WRANGLER"
    printf '%s\n' "$WRANGLER"
    return
  fi
  [ -x "$DEFAULT_W" ] || die "repo-locked wrangler missing at $DEFAULT_W (npm ci or set WRANGLER)"
  printf '%s\n' "$DEFAULT_W"
}

validate_role_config() {
  python3 - "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(cfg, dict):
    raise SystemExit("config must be a JSON object")
if "build" in cfg:
    raise SystemExit("config has a build key — refuse")
account = cfg.get("account_id")
if not isinstance(account, str) or not account.strip():
    raise SystemExit("missing account_id")
name = cfg.get("name")
if not isinstance(name, str) or not name.strip():
    raise SystemExit("missing name")
db = None
for row in cfg.get("d1_databases") or []:
    if isinstance(row, dict) and row.get("binding") == "DB":
        db = row.get("database_id") or row.get("id")
        break
if not isinstance(db, str) or not db.strip():
    raise SystemExit("missing d1_databases[].database_id for binding DB")
print(account)
print(name)
print(db)
PY
}

load_manage() {
  local dir="$1"
  MANAGE_CFG="$dir/manage.json"
  [ -f "$MANAGE_CFG" ] || die "missing $MANAGE_CFG"
  local out
  out="$(validate_role_config "$MANAGE_CFG")" || die "invalid manage config: $(validate_role_config "$MANAGE_CFG" 2>&1 || true)"
  ROLE_ACCOUNT="$(printf '%s\n' "$out" | sed -n '1p')"
  ROLE_DB="$(printf '%s\n' "$out" | sed -n '3p')"
}

with_deploy_env() {
  local dir="$1" account="$2"
  shift 2
  [ "${1:-}" = "--" ] || die "with_deploy_env internal usage"
  shift
  local envfile="$dir/deploy.env"
  [ -f "$envfile" ] || die "missing $envfile"
  (
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN unset after loading deploy.env"
    export CLOUDFLARE_ACCOUNT_ID="$account"
    "$@"
  )
}

# Run a remote D1 statement; prints wrangler --json stdout.
d1_json() {
  local wrangler="$1" instance_dir="$2" account="$3" db="$4" config="$5" sql="$6"
  with_deploy_env "$instance_dir" "$account" -- \
    "$wrangler" d1 execute "$db" --remote --config "$config" --command "$sql" --json
}

parse_d1_rows() {
  # stdin: wrangler --json output → print JSON array of row objects.
  # Use -c so a heredoc cannot steal the pipe.
  python3 -c 'import json,sys
raw=sys.stdin.read()
try:
  data=json.loads(raw)
except Exception as exc:
  raise SystemExit("invalid d1 json: %s" % (exc,))
rows=[]
if isinstance(data, list):
  for block in data:
    if isinstance(block, dict) and isinstance(block.get("results"), list):
      rows.extend(block["results"])
elif isinstance(data, dict) and isinstance(data.get("results"), list):
  rows=data["results"]
print(json.dumps(rows))'
}

validate_instance_id() {
  python3 - "$1" <<'PY'
import re, sys
value = sys.argv[1]
if not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", value):
    raise SystemExit("instance-id must match ^[a-z][a-z0-9-]{1,39}$")
print(value)
PY
}

sql_quote() {
  # Validate + SQL-literal quote. Reject NUL; double single quotes.
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if "\x00" in value:
    raise SystemExit("nul byte rejected")
print("'" + value.replace("'", "''") + "'")
PY
}

new_rg_id() {
  # Mirror domains/catalogue/ids.ts newId('rg'): 128 random bits → unpadded lowercase base32.
  python3 - <<'PY'
import os
alphabet = "abcdefghijklmnopqrstuvwxyz234567"
raw = os.urandom(16)
bits = 0
value = 0
encoded = []
for byte in raw:
    value = (value << 8) | byte
    bits += 8
    while bits >= 5:
        bits -= 5
        encoded.append(alphabet[(value >> bits) & 31])
if bits:
    encoded.append(alphabet[(value << (5 - bits)) & 31])
print("rg_" + "".join(encoded))
PY
}

validate_issuer() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlparse
value = sys.argv[1]
if "\x00" in value or len(value) > 255 or not value.startswith("https://"):
    raise SystemExit("issuer must be https://… ≤255 chars")
parsed = urlparse(value)
if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
    raise SystemExit("issuer URL invalid")
if parsed.query or parsed.fragment:
    raise SystemExit("issuer must not carry query/fragment")
print(value)
PY
}

validate_subject() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if "\x00" in value or not (1 <= len(value) <= 255):
    raise SystemExit("subject must be 1–255 chars without NUL")
# Visible ASCII only — Access subjects that need wider sets should use --email after sign-in.
if any(ord(c) < 33 or ord(c) > 126 for c in value):
    raise SystemExit("subject must be visible ASCII (!–~)")
print(value)
PY
}

validate_email() {
  python3 - "$1" <<'PY'
import re, sys
value = sys.argv[1]
if "\x00" in value or not (1 <= len(value) <= 320):
    raise SystemExit("email must be 1–320 chars without NUL")
if not re.fullmatch(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", value):
    raise SystemExit("email grammar rejected")
print(value)
PY
}

cmd_instance() {
  local instance_dir="" instance_id=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --instance-dir) instance_dir="${2:-}"; shift 2 ;;
      --instance-id) instance_id="${2:-}"; shift 2 ;;
      *) die "unknown instance arg: $1" ;;
    esac
  done
  [ -n "$instance_dir" ] || die "instance requires --instance-dir"
  [ -n "$instance_id" ] || die "instance requires --instance-id"
  [ -d "$instance_dir" ] || die "instance-dir not a directory"
  instance_id="$(validate_instance_id "$instance_id")"
  load_manage "$instance_dir"
  local wrangler id_sql now_ms quoted existing
  wrangler="$(resolve_wrangler)"
  quoted="$(sql_quote "$instance_id")"
  now_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"

  existing="$(d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" \
    "SELECT instance_id FROM instance_meta WHERE singleton = 1;" | parse_d1_rows)"
  local existing_rc
  existing_rc="$(python3 - "$existing" "$instance_id" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
want = sys.argv[2]
if not rows:
    print("absent")
elif isinstance(rows[0], dict) and rows[0].get("instance_id") == want:
    print("same")
else:
    got = rows[0].get("instance_id") if rows and isinstance(rows[0], dict) else None
    print(f"conflict:{got}")
PY
)"
  case "$existing_rc" in
    same)
      info "instance_meta already set to $instance_id — skip"
      return 0
      ;;
    absent) ;;
    conflict:*)
      die "instance_meta already has instance_id=${existing_rc#conflict:}, refusing $instance_id"
      ;;
    *) die "unexpected instance_meta state: $existing_rc" ;;
  esac

  id_sql="INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) SELECT 1, ${quoted}, 1, ${now_ms} WHERE NOT EXISTS (SELECT 1 FROM instance_meta WHERE singleton = 1);"
  d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" "$id_sql" >/dev/null
  existing="$(d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" \
    "SELECT instance_id, contract_version FROM instance_meta WHERE singleton = 1;" | parse_d1_rows)"
  python3 - "$existing" "$instance_id" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
want = sys.argv[2]
if len(rows) != 1 or rows[0].get("instance_id") != want or rows[0].get("contract_version") != 1:
    raise SystemExit(f"instance_meta confirm failed: {rows!r}")
PY
  info "instance_meta inserted instance_id=$instance_id contract_version=1"
}

cmd_first_admin() {
  local instance_dir="" issuer="" subject="" email=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --instance-dir) instance_dir="${2:-}"; shift 2 ;;
      --issuer) issuer="${2:-}"; shift 2 ;;
      --subject) subject="${2:-}"; shift 2 ;;
      --email) email="${2:-}"; shift 2 ;;
      *) die "unknown first-admin arg: $1" ;;
    esac
  done
  [ -n "$instance_dir" ] || die "first-admin requires --instance-dir"
  [ -d "$instance_dir" ] || die "instance-dir not a directory"
  if [ -n "$email" ]; then
    if [ -n "$issuer" ] || [ -n "$subject" ]; then
      die "use either --email or --issuer/--subject, not both"
    fi
    email="$(validate_email "$email")"
  else
    [ -n "$issuer" ] || die "first-admin requires --issuer (or --email)"
    [ -n "$subject" ] || die "first-admin requires --subject (or --email)"
    issuer="$(validate_issuer "$issuer")"
    subject="$(validate_subject "$subject")"
  fi
  load_manage "$instance_dir"
  local wrangler now_ms rg_id
  wrangler="$(resolve_wrangler)"
  now_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
  rg_id="$(new_rg_id)"
  python3 - "$rg_id" <<'PY'
import re, sys
rid = sys.argv[1]
if not re.fullmatch(r"rg_[a-z2-7]{26}", rid) or len(rid) != 29:
    raise SystemExit(f"generated id failed grammar: {rid!r}")
PY

  local principals_sql admins_sql principal_json admin_json
  if [ -n "$email" ]; then
    local eq
    eq="$(sql_quote "$email")"
    principals_sql="SELECT principal_id, status, issuer, subject, email_hint FROM principals WHERE email_hint = ${eq};"
  else
    local iq sq
    iq="$(sql_quote "$issuer")"
    sq="$(sql_quote "$subject")"
    principals_sql="SELECT principal_id, status, issuer, subject, email_hint FROM principals WHERE issuer = ${iq} AND subject = ${sq};"
  fi
  admins_sql="SELECT role_grant_id, principal_id, origin FROM role_grants WHERE role = 'admin' AND scope_kind = 'installation' AND revoked_at IS NULL;"

  principal_json="$(d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" "$principals_sql" | parse_d1_rows)"
  admin_json="$(d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" "$admins_sql" | parse_d1_rows)"

  local decision
  decision="$(python3 - "$principal_json" "$admin_json" <<'PY'
import json, sys
principals = json.loads(sys.argv[1])
admins = json.loads(sys.argv[2])
if len(principals) == 0:
    print("missing_principal")
    raise SystemExit(0)
if len(principals) > 1:
    print("ambiguous_principal")
    raise SystemExit(0)
p = principals[0]
if not isinstance(p, dict) or p.get("status") != "active":
    print("inactive_principal")
    raise SystemExit(0)
pid = p.get("principal_id")
if not isinstance(pid, str) or not pid.startswith("pr_"):
    print("invalid_principal")
    raise SystemExit(0)
active_admins = [a for a in admins if isinstance(a, dict)]
if not active_admins:
    print(f"insert:{pid}")
    raise SystemExit(0)
if len(active_admins) == 1 and active_admins[0].get("principal_id") == pid:
    print(f"same:{active_admins[0].get('role_grant_id')}")
    raise SystemExit(0)
print("admin_exists")
PY
)"

  case "$decision" in
    missing_principal) die "principal not found — sign in once on the management origin first" ;;
    ambiguous_principal) die "email matches multiple principals — use --issuer/--subject" ;;
    inactive_principal) die "principal exists but is not active" ;;
    invalid_principal) die "principal row invalid" ;;
    admin_exists) die "an active installation admin already exists — refuse" ;;
    same:*)
      info "first-admin already granted (${decision#same:}) — skip"
      return 0
      ;;
    insert:pr_*)
      ;;
    *) die "unexpected first-admin decision: $decision" ;;
  esac

  local principal_id pq rq insert_sql
  principal_id="${decision#insert:}"
  pq="$(sql_quote "$principal_id")"
  rq="$(sql_quote "$rg_id")"
  # origin='bootstrap' ⇒ granted_by NULL; installation admin only.
  insert_sql="INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, scope_page_id, origin, granted_at, granted_by, revoked_at, revoked_by) SELECT ${rq}, ${pq}, 'admin', 'installation', NULL, 'bootstrap', ${now_ms}, NULL, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM role_grants WHERE role = 'admin' AND scope_kind = 'installation' AND revoked_at IS NULL);"
  d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" "$insert_sql" >/dev/null

  admin_json="$(d1_json "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$ROLE_DB" "$MANAGE_CFG" "$admins_sql" | parse_d1_rows)"
  python3 - "$admin_json" "$principal_id" <<'PY'
import json, sys
admins = [a for a in json.loads(sys.argv[1]) if isinstance(a, dict)]
pid = sys.argv[2]
if len(admins) != 1 or admins[0].get("principal_id") != pid or admins[0].get("origin") != "bootstrap":
    raise SystemExit(f"first-admin confirm failed: {admins!r}")
PY
  info "first-admin granted role_grant_id=$rg_id principal=$principal_id origin=bootstrap"
}

main() {
  [ "$#" -gt 0 ] || { usage; exit 2; }
  local cmd="$1"
  shift
  case "$cmd" in
    instance) cmd_instance "$@" ;;
    first-admin) cmd_first_admin "$@" ;;
    -h|--help|help) usage ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
