#!/usr/bin/env bash
# forge-doctor output format contracts (--json / --quiet must not mix formats).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCTOR="$ROOT/plugins/silex-forge/scripts/forge-doctor.sh"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "forge-doctor format tests"

json_out=""
json_out=$(bash "$DOCTOR" --json 2>/dev/null) || true
[ -n "$json_out" ] || fail "--json must emit stdout even when config incomplete"
python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$json_out" \
  || fail "--json stdout is not valid JSON"
[[ "$json_out" != silex-forge* ]] || fail "--json must not emit human banner"
echo "$json_out" | grep -q '"config_source"' \
  || fail "--json must include doctor payload keys"
pass "--json emits JSON only"

quiet_out=""
quiet_out=$(bash "$DOCTOR" --quiet 2>/dev/null) || true
[ -z "$quiet_out" ] || fail "--quiet must not print to stdout (got: ${quiet_out:0:80})"
pass "--quiet emits no stdout"

combo_out=""
combo_out=$(bash "$DOCTOR" --json --quiet 2>/dev/null) || true
python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$combo_out" \
  || fail "--json --quiet must still emit JSON only"
[[ "$combo_out" != silex-forge* ]] || fail "--json --quiet must not mix human output"
pass "--json --quiet prefers JSON (no human lines)"

human_out=""
human_out=$(bash "$DOCTOR" 2>/dev/null) || true
[[ "$human_out" == silex-forge* ]] || fail "default mode must emit human banner"
echo "$human_out" | grep -q 'source' || fail "default mode must include human fields"
pass "default mode emits human report"

echo "all forge-doctor format checks passed"
