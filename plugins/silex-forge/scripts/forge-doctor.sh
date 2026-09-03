#!/usr/bin/env bash
# forge-doctor.sh — vérifie config forge (locale + complète) ; exit 1 si KO
#
#   forge-doctor.sh           # rapport humain
#   forge-doctor.sh --json    # JSON only
#   forge-doctor.sh [--json] [--quiet] [--online]
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
  Vérifie ~/.config/silex/forge.config.json (fallback example).
  --online : vérifie aussi token/account/project/KV via API CF.
  Si KO → lancer le skill forge-setup.
EOF
      exit 0
      ;;
  esac
done

[ -d "$LIB_DIR" ] || die "lib manquante: $LIB_DIR"
command -v python3 >/dev/null || die "python3 requis"

if [ "$JSON_ONLY" -eq 1 ]; then
  python3 - <<PY
import json, sys
from load_config import doctor, doctor_online
d = doctor_online() if ${ONLINE} else doctor()
print(json.dumps(d, ensure_ascii=False, indent=2))
ok = d.get("ok") and (d.get("online_ok", True) if ${ONLINE} else True)
sys.exit(0 if ok else 1)
PY
  exit $?
fi

if [ "$QUIET" -eq 1 ]; then
  python3 - <<PY
import sys
from load_config import doctor, doctor_online
d = doctor_online() if ${ONLINE} else doctor()
ok = d.get("ok") and (d.get("online_ok", True) if ${ONLINE} else True)
sys.exit(0 if ok else 1)
PY
  exit $?
fi

python3 - <<PY
import sys
from load_config import doctor, doctor_online

online = ${ONLINE}
d = doctor_online() if online else doctor()
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
print(f"  deploy   : {'OK' if d.get('deploy_ready') else 'KO'}")
if online:
    print(f"  online   : {'OK' if d.get('online_ok') else 'KO'}")
    for k, v in (d.get("online_checks") or {}).items():
        print(f"    {k}: {v}")
ok = d.get("ok") and (d.get("online_ok", True) if online else True)
if ok:
    print("  status   : OK")
    for w in d.get("warnings") or []:
        print(f"  ⚠ {w}")
    sys.exit(0)
print("  status   : KO")
for i in d.get("issues") or []:
    print(f"  ✗ {i}")
for i in d.get("online_issues") or []:
    print(f"  ✗ {i}")
for w in d.get("warnings") or []:
    print(f"  ⚠ {w}")
print()
print("→ Lance le skill forge-setup pour créer/compléter la config locale.")
print(f"  local attendu : {d.get('local_path')}")
print(f"  example       : {d.get('example_path')}")
sys.exit(1)
PY
