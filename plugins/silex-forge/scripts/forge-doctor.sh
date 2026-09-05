#!/usr/bin/env bash
# forge-doctor.sh — check the forge install: local config + deploy credentials
#
#   forge-doctor.sh           # human report
#   forge-doctor.sh --json    # JSON only
#   forge-doctor.sh [--json] [--quiet] [--online]
#
# Exit codes:
#   0  ready         — config OK and deploy credentials complete (+ online OK with --online)
#   1  config KO     — hub/config broken, or a local prerequisite is missing
#   2  deploy blocked — config OK, but Cloudflare deploy cannot run
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
export PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}"

# die stays local on purpose: this script diagnoses a broken install, so it
# must still be able to report a missing lib/ (see the check below). Sourcing
# forge_common.sh here would replace that message with a raw bash error.
die() { echo "✗ $*" >&2; exit 1; }

JSON_ONLY=0
QUIET=0
ONLINE=0
for a in "$@"; do
  case "$a" in
    --json|-j) JSON_ONLY=1 ;;
    --quiet|-q) QUIET=1 ;;
    --online) ONLINE=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: forge-doctor.sh [--json] [--quiet] [--online]
  Checks ~/.config/silex/forge.config.json (example fallback) and the
  Cloudflare credentials in ~/.config/silex/forge.env.
  --online : also check token/account/project/KV against the Cloudflare API.

Exit: 0 ready · 1 config KO (run the forge-setup skill) · 2 deploy blocked
      (each blocker is reported with the command that fixes it).
EOF
      exit 0
      ;;
  esac
done

[ -d "$LIB_DIR" ] || die "lib missing: $LIB_DIR — reinstall the silex-forge plugin"
command -v python3 >/dev/null || die "python3 required — install python3 (>= 3.9), then rerun forge-doctor.sh"

if [ "$JSON_ONLY" -eq 1 ]; then
  python3 - <<PY
import json, sys
from load_config import doctor, doctor_online
online = ${ONLINE}
d = doctor_online() if online else doctor()
print(json.dumps(d, ensure_ascii=False, indent=2))
if not d.get("ok"):
    sys.exit(1)
if online and not d.get("online_ok"):
    sys.exit(2)
sys.exit(0 if d.get("deploy_ready") else 2)
PY
  exit $?
fi

if [ "$QUIET" -eq 1 ]; then
  python3 - <<PY
import sys
from load_config import doctor, doctor_online
online = ${ONLINE}
d = doctor_online() if online else doctor()
if not d.get("ok"):
    n = len(d.get("issues") or [])
    print(
        "✗ forge doctor: config KO (%d issue%s) — run the forge-setup skill"
        % (n, "" if n == 1 else "s"),
        file=sys.stderr,
    )
    sys.exit(1)
if online and not d.get("online_ok"):
    print(
        "✗ forge doctor: online checks KO — forge-doctor.sh --online for details",
        file=sys.stderr,
    )
    sys.exit(2)
if not d.get("deploy_ready"):
    codes = ", ".join(d.get("deploy_blockers") or []) or "unknown"
    print(
        "✗ forge doctor: deploy blocked (%s) — forge-doctor.sh for the fix commands"
        % codes,
        file=sys.stderr,
    )
    sys.exit(2)
sys.exit(0)
PY
  exit $?
fi

# Human report. Python emits two machine lines first (status + blockers), then
# the report; the shell owns the blocker → command map below.
DOCTOR_OUT=$(python3 - <<PY
import sys
from load_config import doctor, doctor_online

online = ${ONLINE}
d = doctor_online() if online else doctor()
ok = bool(d.get("ok"))
deploy = bool(d.get("deploy_ready"))
online_ok = bool(d.get("online_ok")) if online else True
blockers = d.get("deploy_blockers") or []

print("%d %d %d %s" % (ok, deploy, online_ok, d.get("forge_env") or ""))
print("blockers:" + "".join(" " + b for b in blockers))

print("silex-forge · doctor" + (" · online" if online else ""))
print(f"  source   : {d.get('config_source')}")
print(f"  fallback : {d.get('fallback')}")
print(f"  hub_root : {d.get('hub_root') or '—'}")
print(f"  artifacts: {d.get('artifacts_root') or '—'}")
acct = d.get("cloudflare_account_id") or ""
acct_s = f"{acct[:8]}…" if len(acct) > 8 else (acct or "—")
print(f"  pages    : {d.get('pages_project') or 'silex-forge'}")
print(f"  cf acct  : {acct_s}")
print(f"  cf token : {'OK' if d.get('has_token') else 'absent (publish KO)'}")
perm = d.get("forge_env_permissions") or {}
print(f"  env perms: {perm.get('mode') or '—'} {'OK' if perm.get('ok') else 'KO'}")
print(f"  deploy   : {'OK' if deploy else 'KO'}")
if online:
    print(f"  online   : {'OK' if online_ok else 'KO'}")
    for k, v in (d.get("online_checks") or {}).items():
        print(f"    {k}: {v}")

warnings = d.get("warnings") or []
if ok and deploy and online_ok:
    print("  status   : OK")
    for w in warnings:
        print(f"  ⚠ {w}")
elif not ok:
    print("  status   : KO (config)")
    for i in d.get("issues") or []:
        print(f"  ✗ {i}")
    for i in d.get("online_issues") or []:
        print(f"  ✗ {i}")
    for w in warnings:
        print(f"  ⚠ {w}")
    print()
    print("→ run the forge-setup skill to create/complete the local config.")
    print(f"  local expected: {d.get('local_path')}")
    print(f"  example       : {d.get('example_path')}")
else:
    print("  status   : KO (deploy blocked)")
    for i in d.get("online_issues") or []:
        print(f"  ✗ {i}")
    for w in warnings:
        print(f"  ⚠ {w}")
    print()
    print("  hub/config is OK — deploy is blocked by:")
PY
) || die "doctor failed to run — check $LIB_DIR/load_config.py, then rerun forge-doctor.sh"

STATUS_LINE=${DOCTOR_OUT%%$'\n'*}
DOCTOR_REST=${DOCTOR_OUT#*$'\n'}
BLOCKER_LINE=${DOCTOR_REST%%$'\n'*}
REPORT=${DOCTOR_REST#*$'\n'}

D_OK=1
D_DEPLOY=1
D_ONLINE=1
ENV_PATH=""
read -r D_OK D_DEPLOY D_ONLINE ENV_PATH <<<"$STATUS_LINE"
[ -n "$ENV_PATH" ] || ENV_PATH="$HOME/.config/silex/forge.env"
BLOCKERS=${BLOCKER_LINE#blockers:}

# deploy_blockers code → the command that fixes it (load_config.doctor codes).
blocker_hint() {
  case "$1" in
    token)
      echo "→ cf token : add CLOUDFLARE_API_TOKEN to ${ENV_PATH} (chmod 600)" ;;
    account_id)
      echo "→ cf acct  : add CLOUDFLARE_ACCOUNT_ID to ${ENV_PATH}   (forge-discover.sh prints it)" ;;
    kv_id)
      echo "→ shares kv: forge-discover.sh --write   (or forge-provision.sh on a new account)" ;;
    CF_ACCESS_TEAM_DOMAIN)
      echo "→ access   : add CF_ACCESS_TEAM_DOMAIN to ${ENV_PATH}   (forge-discover.sh --write)" ;;
    CF_ACCESS_AUD)
      echo "→ access   : add CF_ACCESS_AUD to ${ENV_PATH}   (forge-discover.sh --write)" ;;
    public_host)
      echo "→ host     : set public_host in the local forge.config.json   (run the forge-setup skill)" ;;
    forge_env_permissions)
      echo "→ env perms: chmod 600 ${ENV_PATH}" ;;
    *)
      echo "→ $1: see forge-doctor.sh --json" ;;
  esac
}

echo "$REPORT"

if [ "$D_OK" -eq 1 ] && { [ "$D_DEPLOY" -eq 0 ] || [ "$D_ONLINE" -eq 0 ]; }; then
  hinted=0
  for code in $BLOCKERS; do
    blocker_hint "$code"
    hinted=1
  done
  if [ "$hinted" -eq 0 ]; then
    echo "→ online   : fix the Cloudflare errors above, then forge-doctor.sh --online"
  fi
  echo "  once fixed: forge-doctor.sh --online"
fi

[ "$D_OK" -eq 1 ] || exit 1
if [ "$D_DEPLOY" -eq 0 ] || [ "$D_ONLINE" -eq 0 ]; then
  exit 2
fi
exit 0
