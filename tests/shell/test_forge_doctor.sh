#!/usr/bin/env bash
# forge-doctor output format contracts (--json / --quiet must not mix formats).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCTOR="$ROOT/plugins/silex-forge/scripts/forge-doctor.sh"
DOCTOR_BASH="${FORGE_BASH:-bash}"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "forge-doctor format tests"

json_out=""
json_out=$("$DOCTOR_BASH" "$DOCTOR" --json 2>/dev/null) || true
[ -n "$json_out" ] || fail "--json must emit stdout even when config incomplete"
python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$json_out" \
  || fail "--json stdout is not valid JSON"
[[ "$json_out" != silex-forge* ]] || fail "--json must not emit human banner"
echo "$json_out" | grep -q '"config_source"' \
  || fail "--json must include doctor payload keys"
pass "--json emits JSON only"

quiet_out=""
quiet_out=$("$DOCTOR_BASH" "$DOCTOR" --quiet 2>/dev/null) || true
[ -z "$quiet_out" ] || fail "--quiet must not print to stdout (got: ${quiet_out:0:80})"
pass "--quiet emits no stdout"

combo_out=""
combo_out=$("$DOCTOR_BASH" "$DOCTOR" --json --quiet 2>/dev/null) || true
python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$combo_out" \
  || fail "--json --quiet must still emit JSON only"
[[ "$combo_out" != silex-forge* ]] || fail "--json --quiet must not mix human output"
pass "--json --quiet prefers JSON (no human lines)"

human_out=""
human_out=$("$DOCTOR_BASH" "$DOCTOR" 2>/dev/null) || true
[[ "$human_out" == silex-forge* ]] || fail "default mode must emit human banner"
echo "$human_out" | grep -q 'source' || fail "default mode must include human fields"
pass "default mode emits human report"

# The doctor diagnoses broken installs, so it must survive one: with lib/
# absent it has to name the missing directory, not die on an internal source.
broken="$(mktemp -d)"
mkdir -p "$broken/scripts"
cp "$DOCTOR" "$broken/scripts/"
broken_out=$("$DOCTOR_BASH" "$broken/scripts/forge-doctor.sh" 2>&1) || true
rm -rf "$broken"
echo "$broken_out" | grep -q 'lib manquante' \
  || fail "missing lib/ must report 'lib manquante', got: ${broken_out:0:120}"
if echo "$broken_out" | grep -qi 'No such file or directory'; then
  fail "missing lib/ leaked a raw shell error instead of the diagnostic"
fi
pass "missing lib/ is reported, not crashed on"

echo "all forge-doctor format checks passed"
